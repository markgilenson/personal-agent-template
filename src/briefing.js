/**
 * Morning briefing — runs Sunday–Thursday at 08:00 Israel time.
 * Checks Asana, Gmail, Drive, and Calendar, then sends a status DM to Mark.
 */

const cron = require('node-cron');
const { runAgent } = require('./agent');
const mem = require('./memory');
const { splitMessage } = require('./util');

const BRIEFING_PROMPT = `סקירת בוקר. בדוק הכל ותציע פעולות קונקרטיות:

**כלל ברזל לג'ימייל: השתמש תמיד ב-newer_than:7d בכל קוורי. אל תציג שום מייל ישן מ-7 ימים — גם אם הוא unread. מייל ישן שלא טופל הוא לא דחוף.**

1. זיכרון ושיחות קודמות — יש עניינים פתוחים שלא סיימנו? תפרט ותציע להמשיך בהם.
2. אסאנה — משימות פתוחות, דחופות, או כאלה שפג תוקפן. הצע מה לטפל בו היום.
3. ג'ימייל — מיילים מ-7 הימים האחרונים שדורשים מענה. השתמש בקוורי: "in:inbox newer_than:7d". לכל מייל שנראה שצריך מענה — קרא את ה-thread המלא (read_thread) ובדוק אם מארק כבר ענה. אם ענה — אל תסמן כ"ממתין למענה". רק אם לא ענה — סמן ולהציע טיוטה. עדיפות: יורם, ספקים בינלאומיים, הורים דחופים.
4. קלנדר — מה בשבוע הקרוב? יש הכנה שנדרשת לפני פגישה או אירוע?
5. Drive — קבצים שנערכו לאחרונה ועבודה פתוחה.

אל תסתפק בסיכום — לכל פריט תציע פעולה קונקרטית ושאל אם להמשיך. "יש מייל מיורם שממתין — רוצה שאכין תשובה?"
קצר, ממוקד, מוכן לפעולה.`;

async function sendDM(discordClient, text) {
  const user = await discordClient.users.fetch(process.env.MARK_DISCORD_ID);
  const dm = await user.createDM();
  const chunks = splitMessage(text);
  for (const chunk of chunks) await dm.send(chunk);
}

function startBriefingSchedule(discordClient) {
  // ── Proactive check — every 2 hours during Israeli work hours (Sun–Thu) ──────
  // If the last conversation message was from the agent AND there are open threads,
  // reach out and propose to continue.
  cron.schedule('0 9,11,13,15,17 * * 0-4', async () => {
    try {
      const history = mem.getHistory(2);
      const lastMessage = history[history.length - 1];
      if (!lastMessage || lastMessage.role !== 'assistant') return; // Mark spoke last — no need to prod

      const openThreads = mem.recallAll()
        .filter(f => f.key.startsWith('learned_open_') && f.value !== '__resolved__');
      if (!openThreads.length) return; // Nothing open

      const threadList = openThreads.slice(0, 3).map(f => `• ${f.value}`).join('\n');
      const prompt = `יש עניינים פתוחים מהשיחה האחרונה ומארק לא הגיב. פנה אליו בעברית, קצר ותכליתי — תזכיר מה פתוח ושאל אם להמשיך. אל תגיד "שלום" גנרי. דוגמה: "יש לנו עוד [X] — רוצה שאמשיך?"\n\nעניינים פתוחים:\n${threadList}`;

      const { text } = await runAgent(prompt, () => {});
      if (text && text.trim()) await sendDM(discordClient, text);

      console.log('[proactive] Sent proactive follow-up.');
    } catch (err) {
      console.error('[proactive] Error:', err.message);
    }
  }, { timezone: 'Asia/Jerusalem' });

  // ── Morning briefing — 08:00 Israel time, Sunday–Thursday ────────────────────
  cron.schedule('0 8 * * 0-4', async () => {
    console.log('[briefing] Starting morning briefing…');

    try {
      const { text } = await runAgent(BRIEFING_PROMPT, () => {});

      if (!text || !text.trim()) {
        console.error('[briefing] Empty response from agent');
        return;
      }

      const dateStr = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
      await sendDM(discordClient, `🌅 **סקירת בוקר — ${dateStr}**\n\n${text}`);

      console.log('[briefing] Morning briefing sent.');
    } catch (err) {
      console.error('[briefing] Error:', err.message);
    }
  }, {
    timezone: 'Asia/Jerusalem',
  });

  console.log('[briefing] Scheduled: 08:00 Sun–Thu (Asia/Jerusalem)');
}

module.exports = { startBriefingSchedule };
