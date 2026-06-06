const { google } = require('googleapis');
const { getAuth } = require('../google-auth');

// ── Read ──────────────────────────────────────────────────────────────────────

async function readInbox({ maxResults = 10, query = '' } = {}) {
  const gmail = google.gmail({ version: 'v1', auth: getAuth() });
  const q = query || 'in:inbox is:unread';
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults });
  const ids = (list.data.messages || []).map(m => m.id);
  if (!ids.length) return [];

  const messages = await Promise.all(ids.map(id =>
    gmail.users.messages.get({ userId: 'me', id, format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'] })
  ));

  return messages.map(m => {
    const h = Object.fromEntries(m.data.payload.headers.map(h => [h.name, h.value]));
    return {
      id: m.data.id,
      threadId: m.data.threadId,  // use this with read_thread
      from: h.From,
      to: h.To,
      subject: h.Subject,
      date: h.Date,
      snippet: m.data.snippet,
    };
  });
}

async function readThread(id) {
  const gmail = google.gmail({ version: 'v1', auth: getAuth() });
  // In a threads.get response, each message's fields are at m.payload directly
  // (not m.data.payload, which is the shape of a standalone messages.get response).
  const formatMessages = messages => messages.map(m => {
    const headers = m.payload?.headers || [];
    const h = Object.fromEntries(headers.map(h => [h.name, h.value]));
    return {
      messageId: m.id,
      from: h.From,
      to: h.To || null,
      cc: h.Cc || null,
      date: h.Date,
      body: m.payload ? extractBody(m.payload) : '(no payload)',
      attachments: m.payload ? listAttachments(m.payload) : [],
    };
  });
  try {
    const thread = await gmail.users.threads.get({ userId: 'me', id, format: 'full' });
    return formatMessages(thread.data.messages);
  } catch (err) {
    if (err.code !== 404) throw err;
    // id was a message ID — resolve its thread ID and retry
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata' });
    const thread = await gmail.users.threads.get({ userId: 'me', id: msg.data.threadId, format: 'full' });
    return formatMessages(thread.data.messages);
  }
}

function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').slice(0, 2000);
  }
  if (payload.parts) {
    // Recurse into nested multipart containers (multipart/mixed, multipart/alternative, etc.)
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8').slice(0, 2000);
      }
      if (part.mimeType?.startsWith('multipart/') && part.parts) {
        const nested = extractBody(part);
        if (nested !== '(no text body)') return nested;
      }
    }
    // Fall back to HTML, stripped of tags
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
      }
    }
  }
  return '(no text body)';
}

// Walk the MIME tree and collect every real file attachment (has a filename + attachmentId).
function listAttachments(payload, out = []) {
  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      attachmentId: payload.body.attachmentId,
      size: payload.body.size,
    });
  }
  if (payload.parts) for (const part of payload.parts) listAttachments(part, out);
  return out;
}

// Walk MIME tree and collect all parts that look like attachments.
function collectAttachmentParts(payload, out = []) {
  if (payload.body?.attachmentId || (payload.filename && payload.body?.data)) {
    out.push(payload);
  }
  if (payload.parts) payload.parts.forEach(p => collectAttachmentParts(p, out));
  return out;
}

// Find a specific attachment part: exact match → case-insensitive → first available.
function findAttachmentPart(payload, filename) {
  const parts = collectAttachmentParts(payload);
  if (!parts.length) return null;
  if (!filename) return parts[0];
  const lower = filename.toLowerCase();
  return (
    parts.find(p => p.filename === filename) ||
    parts.find(p => p.filename?.toLowerCase() === lower) ||
    parts[0]
  );
}

async function readAttachment(messageId, attachmentId, filename = '') {
  const gmail = google.gmail({ version: 'v1', auth: getAuth() });

  let buf;
  try {
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const part = findAttachmentPart(msg.data.payload, filename);

    console.log(`[gmail] readAttachment: want="${filename}" found="${part?.filename}" inline=${!!part?.body?.data} freshId=${part?.body?.attachmentId}`);

    if (part?.body?.data) {
      buf = Buffer.from(part.body.data, 'base64url');
    } else {
      const freshId = part?.body?.attachmentId || attachmentId;
      const att = await gmail.users.messages.attachments.get({
        userId: 'me', messageId, id: freshId,
      });
      if (!att.data?.data) return { filename, text: '', error: 'Gmail returned no attachment data.' };
      buf = Buffer.from(att.data.data, 'base64url');
    }
  } catch (err) {
    console.error(`[gmail] readAttachment error: ${err.message}`);
    return { filename, text: '', error: `Failed to fetch attachment: ${err.message}` };
  }

  // Unified parser: PDF, Word (.docx), Excel (.xlsx), text/CSV/JSON/code, images.
  const { parseFileToText } = require('../files');
  const r = await parseFileToText(buf, filename, '');
  return { filename, text: r.text || '', note: r.note, error: r.error };
}

// ── Draft (returns draft object — never sends automatically) ──────────────────

async function createDraft({ to, subject, body, replyToMessageId } = {}) {
  const gmail = google.gmail({ version: 'v1', auth: getAuth() });

  let raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  if (replyToMessageId) {
    const orig = await gmail.users.messages.get({ userId: 'me', id: replyToMessageId, format: 'metadata',
      metadataHeaders: ['Message-ID', 'References'] });
    const headers = Object.fromEntries(orig.data.payload.headers.map(h => [h.name, h.value]));
    raw = [`In-Reply-To: ${headers['Message-ID']}`, `References: ${headers['Message-ID']}`, raw].join('\r\n');
  }

  const encoded = Buffer.from(raw).toString('base64url');
  const draft = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encoded } } });
  return { draftId: draft.data.id, to, subject, body };
}

// Update an existing draft in place (used by the Refine flow). Never sends.
async function updateDraft(draftId, { to, subject, body, replyToMessageId } = {}) {
  const gmail = google.gmail({ version: 'v1', auth: getAuth() });

  let raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  if (replyToMessageId) {
    const orig = await gmail.users.messages.get({ userId: 'me', id: replyToMessageId, format: 'metadata',
      metadataHeaders: ['Message-ID', 'References'] });
    const headers = Object.fromEntries(orig.data.payload.headers.map(h => [h.name, h.value]));
    raw = [`In-Reply-To: ${headers['Message-ID']}`, `References: ${headers['Message-ID']}`, raw].join('\r\n');
  }

  const encoded = Buffer.from(raw).toString('base64url');
  await gmail.users.drafts.update({ userId: 'me', id: draftId, requestBody: { message: { raw: encoded } } });
  return { draftId, to, subject, body };
}

// NOTE: There is intentionally NO send function. The agent saves Gmail drafts;
// Mark reviews and sends them himself. Do not add a send capability.

module.exports = { readInbox, readThread, readAttachment, createDraft, updateDraft };
