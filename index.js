require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { runAgent, refineDraft } = require('./src/agent');
const mem = require('./src/memory');
const gmail = require('./src/tools/gmail');
const calendar = require('./src/tools/calendar');
const asana = require('./src/tools/asana');
const drive = require('./src/tools/drive');
const whatsapp = require('./src/tools/whatsapp');
const { startWebServer } = require('./src/webServer');
const { startBriefingSchedule } = require('./src/briefing');
const { splitMessage } = require('./src/util');

// Start web server for OAuth and health checks
startWebServer();

// ── Groq Whisper transcription ────────────────────────────────────────────────

async function transcribeAudio(audioBuffer, mediaType) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    // Strip codec suffix (e.g. "audio/ogg; codecs=opus" → "audio/ogg")
    const mimeType = (mediaType || 'audio/ogg').split(';')[0].trim();
    // Pick a filename extension that matches the container so Groq routes it correctly
    const ext = mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
              : mimeType.includes('webm') ? 'webm'
              : mimeType.includes('wav')  ? 'wav'
              : mimeType.includes('mp3')  ? 'mp3'
              : 'ogg';

    const blob = new Blob([audioBuffer], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'text');
    formData.append('temperature', '0');   // deterministic — eliminates "thank you" hallucinations
    // Prompt anchors the language so Whisper doesn't guess and fill silence with English phrases
    formData.append('prompt', 'מארק, מרכז ירושלים למוסיקה. JMC. Mark, Jerusalem Music Centre.');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error?.message || `HTTP ${res.status}`;
      console.error('[speech] Groq STT error:', msg);
      return { error: msg };
    }

    const text = await res.text();
    // Reject known hallucination phrases that Whisper emits for silence/noise
    const cleaned = text.trim();
    const HALLUCINATIONS = /^(thank you\.?|thanks\.?|thank you for watching\.?|\.+)$/i;
    if (!cleaned || HALLUCINATIONS.test(cleaned)) return null;
    return cleaned;
  } catch (e) {
    console.error('[speech] Transcription failed:', e.message);
    return { error: e.message };
  }
}


const MARK_DISCORD_ID = process.env.MARK_DISCORD_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ── Guard: only respond to Mark ───────────────────────────────────────────────

function isMarkDM(msg) {
  if (msg.author.bot) return false;
  if (MARK_DISCORD_ID && msg.author.id !== MARK_DISCORD_ID) return false;
  if (msg.guild) return false; // DMs only
  return true;
}

// ── Cards ─────────────────────────────────────────────────────────────────────

// Email drafts are never sent by the bot — the card offers Refine + Dismiss only.
function buildDraftCard(action) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`refine_${action.id}`)
      .setLabel('✏️ שכתב')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dismiss_${action.id}`)
      .setLabel('✓ סגור')
      .setStyle(ButtonStyle.Secondary),
  );
  return { content: action.previewText, components: [row] };
}

// Quick-choice card — one button per option. Mark's click re-invokes the agent.
function buildAskMarkCard(action) {
  const buttons = action.payload.options.map((opt, i) =>
    new ButtonBuilder()
      .setCustomId(`askopt_${action.id}_${i}`)
      .setLabel(opt)
      .setStyle(ButtonStyle.Primary)
  );
  // Discord allows max 5 buttons per row; our cap is 4, so one row is fine
  const row = new ActionRowBuilder().addComponents(...buttons);
  return { content: action.previewText, components: [row] };
}

// Write actions that DO execute (calendar, task, doc) keep approve/cancel.
function buildApprovalCard(action) {
  if (action.type === 'email_draft') return buildDraftCard(action);
  if (action.type === 'ask_mark')   return buildAskMarkCard(action);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${action.id}`)
      .setLabel('✅ אשר')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cancel_${action.id}`)
      .setLabel('❌ בטל')
      .setStyle(ButtonStyle.Danger),
  );
  return { content: action.previewText, components: [row] };
}

// ── Execute an approved action ────────────────────────────────────────────────
// NOTE: no send_email case — the bot never sends email, only saves drafts.

async function executeApproved(action) {
  switch (action.type) {
    case 'create_event':
      return await calendar.createEvent(action.payload.event);
    case 'create_task':
      return await asana.createTask(action.payload.task);
    case 'update_task':
      return await asana.updateTask(action.payload.gid, action.payload.fields);
    case 'append_doc':
      return await drive.appendToDoc(action.payload.fileId, action.payload.text);
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

// ── DM message handler ────────────────────────────────────────────────────────

client.on('messageCreate', async msg => {
  if (!isMarkDM(msg)) return;
  // Slash-commands (e.g. /settoken) are handled by their own listener — never
  // forward them to the agent, so secrets don't reach the LLM.
  if (msg.content?.startsWith('/')) return;

  // Build the full message — inline text + file attachments + voice messages
  let fullContent = msg.content || '';
  const images = []; // {mediaType, data} blocks for the vision model

  if (msg.attachments.size > 0) {
    for (const [, attachment] of msg.attachments) {
      const contentType = attachment.contentType || '';
      const name = attachment.name || '';

      // Images — send to Opus as vision input
      const isImage = contentType.startsWith('image/') && contentType !== 'image/svg+xml';
      if (isImage && attachment.url) {
        try {
          const res = await fetch(attachment.url);
          const buf = Buffer.from(await res.arrayBuffer());
          // Opus accepts png, jpeg, gif, webp. Cap ~5MB to stay within limits.
          if (buf.length <= 5 * 1024 * 1024) {
            images.push({ mediaType: contentType, data: buf.toString('base64') });
            fullContent += `\n\n[תמונה מצורפת: ${name}]`;
          } else {
            fullContent += `\n\n[תמונה ${name} גדולה מדי לניתוח — מעל 5MB]`;
          }
        } catch (e) {
          fullContent += `\n\n[תמונה מצורפת: ${name} — שגיאה בקריאה]`;
        }
        continue;
      }

      // Voice message (.ogg) or other audio — transcribe with Groq Whisper if key is set
      const isAudio = contentType.startsWith('audio/') || /\.(ogg|mp3|mp4|wav|webm|m4a)$/i.test(name);
      if (isAudio && attachment.url) {
        try {
          const res = await fetch(attachment.url);
          const buf = await res.arrayBuffer();
          const transcript = await transcribeAudio(Buffer.from(buf), contentType || 'audio/ogg');
          if (transcript && typeof transcript === 'string') {
            fullContent = transcript + (fullContent.trim() ? '\n' + fullContent : '');
            // Show what was heard so Mark can catch transcription errors
            await msg.channel.send(`🎙️ _שמעתי: "${transcript}"_`).catch(() => {});
          } else if (transcript && transcript.error) {
            fullContent = `[שגיאת תמלול: ${transcript.error}]`;
          } else if (!fullContent.trim()) {
            fullContent = '[הודעה קולית — הוסף GROQ_API_KEY ל-Railway לתמלול]';
          }
        } catch (e) {
          if (!fullContent.trim()) fullContent = `[הודעה קולית — שגיאה: ${e.message}]`;
        }
        continue;
      }

      // Everything else — PDF, Word (.docx), Excel (.xlsx), text/CSV/JSON/code.
      if (attachment.url) {
        try {
          const res = await fetch(attachment.url);
          const buf = Buffer.from(await res.arrayBuffer());
          const { parseFileToText } = require('./src/files');
          const r = await parseFileToText(buf, name, contentType);
          if (r.text) fullContent += `\n\n[קובץ מצורף: ${name}]\n${r.text}`;
          else fullContent += `\n\n[קובץ מצורף: ${name} — ${r.note || r.error}]`;
        } catch (e) {
          fullContent += `\n\n[קובץ מצורף: ${name} — שגיאה בהורדה: ${e.message}]`;
        }
      }
    }
  }

  if (!fullContent.trim() && !images.length) return;

  // Live message — shows tool progress while working, then the answer streaming
  // in as the model writes it. One Discord message, continuously edited.
  const statusMsg = await msg.channel.send('⏳ עובד על זה…');
  let finished = false;
  const startedAt = Date.now();

  // Streaming state
  let mode = 'status';            // 'status' (tool/progress) | 'stream' (answer building)
  let currentLabel = '⏳ עובד על זה…';
  let streamedText = '';          // accumulated answer deltas for the current turn
  let lastEdited = '⏳ עובד על זה…';

  const elapsedStr = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    if (s < 60) return `${s} שניות`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} דקות`;
  };

  // Discord caps messages at 2000 chars — show the head while streaming;
  // the full answer is re-chunked properly at the end.
  const capForPreview = s => (s.length > 1900 ? s.slice(0, 1900) + ' …' : s);

  // Single render path, throttled by the ticker below.
  const flush = async () => {
    if (finished) return;
    let content;
    if (mode === 'stream' && streamedText.trim()) {
      content = capForPreview(streamedText);
    } else {
      const elapsed = Date.now() - startedAt;
      let footer = '';
      if (elapsed > 45000) {
        footer = `\n⏱️ עובד כבר ${elapsedStr()} — משימה ארוכה, אני עליה. לא תקוע, אעדכן ברגע שאסיים.`;
      } else if (elapsed > 15000) {
        footer = `\n⏱️ ${elapsedStr()}…`;
      }
      content = `${currentLabel}${footer}`;
    }
    if (content === lastEdited) return;
    lastEdited = content;
    await statusMsg.edit(content).catch(() => {});
  };

  // A tool started — discard any partial text and show what it's doing.
  const updateStatus = (label) => {
    mode = 'status';
    streamedText = '';
    currentLabel = label;
  };

  // The model is writing the answer — accumulate deltas; the ticker pushes them.
  const onStream = (delta) => {
    mode = 'stream';
    streamedText += delta;
  };

  // Push updates ~once a second (well under Discord's edit rate limit).
  const ticker = setInterval(flush, 1100);

  // Generous cap so genuinely complex, multi-step work isn't cut off.
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
  );

  try {
    const { text, pendingActions } = await Promise.race([
      runAgent(fullContent, updateStatus, images, onStream),
      timeoutPromise,
    ]);

    finished = true;
    clearInterval(ticker);

    if (!text || !text.trim()) {
      await statusMsg.edit('⚠️ לא הצלחתי לסיים את המשימה. נסה לנסח מחדש.').catch(() => {});
      return;
    }

    // Replace the streaming preview with the full, properly-chunked answer
    const chunks = splitMessage(text);
    await statusMsg.edit(chunks[0]).catch(() => {});
    for (const chunk of chunks.slice(1)) {
      await msg.channel.send(chunk);
    }

    for (const action of pendingActions) {
      await msg.channel.send(buildApprovalCard(action));
    }
  } catch (err) {
    finished = true;
    clearInterval(ticker);
    console.error('Agent error:', err);

    const errText = err.message === 'timeout'
      ? `⏱️ עברו ${elapsedStr()} ועדיין לא סיימתי — עצרתי כדי לא להיתקע. נסה שוב או פרק את הבקשה לחלקים קטנים יותר.`
      : `⚠️ שגיאה: ${err.message}`;

    await statusMsg.edit(errText).catch(() => {});
  }
});

// ── /settoken command — permanently saves a credential as Railway env var ─────
// Usage (DM only): /settoken google <refresh_token>

client.on('messageCreate', async msg => {
  if (!isMarkDM(msg)) return;
  if (!msg.content.startsWith('/settoken ')) return;

  const parts = msg.content.split(' ');
  const service = parts[1];
  const token = parts.slice(2).join(' ').trim();

  if (!service || !token) {
    await msg.reply('Usage: `/settoken google <token>`');
    return;
  }

  if (service === 'google') {
    mem.remember('google_refresh_token', token);
    // Also set as Railway env var so it survives DB wipes
    const { execSync } = require('child_process');
    try {
      execSync(`railway variables set GOOGLE_REFRESH_TOKEN="${token}"`, { cwd: __dirname });
    } catch (e) {
      // Railway CLI not available on Railway itself — token is in DB, that's enough
    }
    await msg.reply('✅ Google refresh token saved permanently.');
  } else {
    await msg.reply(`⚠️ Unknown service: ${service}`);
  }
});

// ── Interaction handler (buttons + refine modal) ──────────────────────────────

client.on('interactionCreate', async interaction => {
  if (MARK_DISCORD_ID && interaction.user.id !== MARK_DISCORD_ID) {
    if (interaction.isRepliable()) await interaction.reply({ content: '⛔', ephemeral: true });
    return;
  }

  // Refine modal submitted → rewrite the draft and update it in place (never sends)
  if (interaction.isModalSubmit() && interaction.customId.startsWith('refinemodal_')) {
    const actionId = interaction.customId.slice('refinemodal_'.length);
    const pending = mem.getPending(actionId);
    if (!pending) {
      await interaction.reply({ content: '⚠️ הטיוטה כבר נסגרה.', ephemeral: true });
      return;
    }
    const instruction = interaction.fields.getTextInputValue('instruction');
    await interaction.deferUpdate();
    try {
      const revised = await refineDraft(pending.payload, instruction);
      const updated = { ...pending.payload, subject: revised.subject, body: revised.body };
      await gmail.updateDraft(updated.draftId, updated);
      mem.storePending(actionId, 'email_draft', updated);
      const preview = `✏️ **טיוטה עודכנה ב-Gmail** (לא נשלח — תשלח בעצמך)\n**To:** ${updated.to}\n**Subject:** ${updated.subject}\n\n${updated.body}`;
      await interaction.editReply(buildDraftCard({ id: actionId, type: 'email_draft', previewText: preview }));
    } catch (err) {
      await interaction.editReply({ content: `⚠️ שגיאה בשכתוב: ${err.message}`, components: [] });
    }
    return;
  }

  if (!interaction.isButton()) return;
  const { customId } = interaction;

  // Refine button → open a modal asking what to change
  if (customId.startsWith('refine_')) {
    const actionId = customId.slice('refine_'.length);
    if (!mem.getPending(actionId)) {
      await interaction.reply({ content: '⚠️ הטיוטה כבר נסגרה.', ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`refinemodal_${actionId}`)
      .setTitle('שכתוב טיוטה');
    const input = new TextInputBuilder()
      .setCustomId('instruction')
      .setLabel('מה לשנות?')
      .setPlaceholder('קצר יותר / רשמי יותר / הוסף את התקציב…')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (customId.startsWith('dismiss_')) {
    const actionId = customId.slice('dismiss_'.length);
    mem.popPending(actionId);
    await interaction.update({ content: `${interaction.message.content}\n\n✓ נסגר (הטיוטה שמורה ב-Gmail).`, components: [] });
    return;
  }

  if (customId.startsWith('approve_')) {
    const actionId = customId.slice('approve_'.length);
    const action = mem.popPending(actionId);
    if (!action) {
      await interaction.reply({ content: '⚠️ פעולה זו כבר בוצעה או פגה תוקפה.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    try {
      const result = await executeApproved(action);
      await interaction.editReply({ content: `✅ בוצע — ${JSON.stringify(result)}`, components: [] });
    } catch (err) {
      await interaction.editReply({ content: `⚠️ שגיאה בביצוע: ${err.message}`, components: [] });
    }
    return;
  }

  if (customId.startsWith('cancel_')) {
    const actionId = customId.slice('cancel_'.length);
    mem.popPending(actionId); // discard
    await interaction.update({ content: '❌ בוטל.', components: [] });
    return;
  }

  // ask_mark option clicked — pop the pending, re-invoke agent with Mark's answer
  if (customId.startsWith('askopt_')) {
    const parts = customId.slice('askopt_'.length).split('_');
    const optIdx = parseInt(parts.pop(), 10);
    const actionId = parts.join('_');

    const action = mem.popPending(actionId);
    if (!action) {
      await interaction.reply({ content: '⚠️ שאלה זו כבר נענתה.', ephemeral: true });
      return;
    }

    const chosen  = action.payload.options[optIdx];
    const question = action.payload.question;

    // Collapse the buttons and show the choice
    await interaction.update({
      content: `${interaction.message.content}\n\n✅ **בחרת:** ${chosen}`,
      components: [],
    });

    // Run the agent with the answer as a new user turn
    const dm = await interaction.user.createDM();
    const statusMsg = await dm.send('⏳ עובד על זה…');
    const syntheticMessage = `[תשובה לשאלה שלך "${question}": "${chosen}"]`;

    try {
      const { text, pendingActions: pas } = await runAgent(syntheticMessage, label => {
        statusMsg.edit(label).catch(() => {});
      });

      const chunks = splitMessage(text || '⚠️ לא הצלחתי לסיים את המשימה.');
      await statusMsg.edit(chunks[0]).catch(() => {});
      for (const chunk of chunks.slice(1)) await dm.send(chunk);
      for (const pa of pas) await dm.send(buildApprovalCard(pa));
    } catch (err) {
      await statusMsg.edit(`⚠️ שגיאה: ${err.message}`).catch(() => {});
    }
    return;
  }
});

// ── /memory command — view and prune agent memory ─────────────────────────────
// Usage: /memory          → view all memory entries
//        /memory del <key>  → delete a specific key
//        /memory delprefix <prefix> → delete all keys with prefix

client.on('messageCreate', async msg => {
  if (!isMarkDM(msg)) return;
  if (!msg.content?.startsWith('/memory')) return;

  const parts = msg.content.trim().split(/\s+/);
  const sub = parts[1];

  if (sub === 'del' && parts[2]) {
    const key = parts.slice(2).join(' ');
    mem.forget(key);
    await msg.reply(`🗑️ Deleted: \`${key}\``);
    return;
  }

  if (sub === 'delprefix' && parts[2]) {
    const prefix = parts[2];
    mem.forgetByPrefix(prefix);
    await msg.reply(`🗑️ Deleted all keys starting with \`${prefix}\``);
    return;
  }

  // Default: view all memory
  const all = mem.recallAll().filter(f => f.value !== '__deleted__' && f.value !== '__resolved__');
  if (!all.length) {
    await msg.reply('Memory is empty.');
    return;
  }

  const lines = all.map(f => `\`${f.key}\`: ${f.value.slice(0, 120)}`);
  const chunks = [];
  let buf = `**Memory (${all.length} entries):**\n`;
  for (const line of lines) {
    if ((buf + line + '\n').length > 1900) {
      chunks.push(buf);
      buf = '';
    }
    buf += line + '\n';
  }
  if (buf.trim()) chunks.push(buf);

  for (const chunk of chunks) await msg.channel.send(chunk);
});

// ── /wa-connect command ───────────────────────────────────────────────────────

client.on('messageCreate', async msg => {
  if (!isMarkDM(msg)) return;
  if (msg.content?.trim() !== '/wa-connect') return;
  await msg.reply('🔄 Connecting to WhatsApp…');
  await startWhatsApp();
});

// ── WhatsApp init ─────────────────────────────────────────────────────────────

async function startWhatsApp() {
  try {
    await whatsapp.connect(async qrString => {
      // Generate QR code as PNG and send to Mark's Discord DM
      const QRCode = require('qrcode');
      const buf = await QRCode.toBuffer(qrString, { scale: 10 });
      const attachment = new AttachmentBuilder(buf, { name: 'whatsapp-qr.png' });
      const user = await client.users.fetch(MARK_DISCORD_ID).catch(() => null);
      const dm   = user ? await user.createDM().catch(() => null) : null;
      if (dm) {
        await dm.send({ content: '📱 **Scan to connect WhatsApp** (expires in ~60s):', files: [attachment] });
      } else {
        console.log('[whatsapp] Could not find Mark\'s DM channel to send QR');
      }
    });
  } catch (err) {
    console.error('[whatsapp] init error:', err.message);
  }
}

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`agent online as ${client.user.tag}`);
  startBriefingSchedule(client);
  // WhatsApp is opt-in — unofficial (Baileys) and risks a personal-number ban.
  // Set ENABLE_WHATSAPP=true to turn it on; otherwise the agent runs without it.
  if (process.env.ENABLE_WHATSAPP === 'true') {
    startWhatsApp();
  } else {
    console.log('[whatsapp] disabled (set ENABLE_WHATSAPP=true to enable)');
  }
});

client.login(process.env.DISCORD_TOKEN);
