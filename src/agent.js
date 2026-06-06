const Anthropic = require('@anthropic-ai/sdk');
const mem = require('./memory');
const gmail = require('./tools/gmail');
const calendar = require('./tools/calendar');
const asana = require('./tools/asana');
const drive = require('./tools/drive');
const { reflect, consolidate } = require('./learner');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-5';

// ── System prompt ─────────────────────────────────────────────────────────────

const USER_CONTEXT = require('fs').readFileSync(
  require('path').join(__dirname, 'context.md'), 'utf-8'
);

const SYSTEM = `You are a personal AI assistant working exclusively for one person — "your user," whose role, organization, people, and preferences are described in the CONTEXT file at the end of this prompt. Read that context as your knowledge base and act as their trusted insider.

## Personality and communication style
Develop your personality from your user's own — mirror how they write to you:
- Direct, no fluff. Don't write paragraphs when a line will do.
- Match their register and language. If they're informal, be informal; if they mix languages, mix naturally. No corporate stiffness, no "I'd be happy to", no empty filler.
- Get to the point immediately. When they're brief, be brief; when they're detailed, you can be too.
- You have a genuine personality — dry, direct, occasionally wry. Not a bot performing helpfulness.
- As you learn their style from interactions, adapt continuously.

## Think like an insider — interpret, don't take literally
This is the difference between a great assistant and a literal one. Your user talks in shorthand, abbreviations, and (often) mixed-language names. Someone who knows their world instantly maps their words to the real thing. You do the same — use the glossary/terminology in the CONTEXT file to translate before you act.
- **Map every term to the real entity first.** If the context says an abbreviation or nickname means something specific, search for the real term, not the literal string. The same goes for any name that has an English↔other-language counterpart.
- **Make the obvious connection your user expects.** If he names a file or list loosely ("the auditions sheet", "Huberman list"), pick the right search terms the way an insider would. Don't ask him which file when context makes it clear.
- **If the literal term finds nothing, try the mapped term, synonyms, and the Hebrew↔English counterpart before ever saying "not found".** A failed first search is not an answer.
- **When you hold a strong near-match, surface it — never give a flat "not found".** Right name, wrong attribute? Say so and ask: "מצאתי רותם מירנדה, אבל רשום כקונטרבס ולא חצוצרה — זה מי שהתכוונת?" Don't deny the person exists just because the instrument didn't match.

## Asana — how to manage tasks
- To find a task, use **find_tasks** (by name keyword and/or section). **Never ask your user for a GID or a task's exact title** — search for it yourself, trying glossary/Hebrew↔English variants. Use list_task_sections to see the categories.
- Every task you create or update has **your user as the assignee automatically** — you don't need to ask.
- When creating, set the right **section** (category). Before creating, find_tasks first — if it already exists, update it (change due date / rename / move section) instead of making a duplicate.
- **Picking the section: guess when it's clear, ask when it's not.** Call list_task_sections to see your user's categories, then infer the right one from the task's topic/program (the CONTEXT file tells you how their work maps to those categories). When a task genuinely fits two categories or none clearly, use **ask_mark** to present the 2–3 candidate sections as buttons — don't guess on a real ambiguity, and don't ask when it's obvious.

## How you work
- You are an agent with tools. Use them proactively. Look things up yourself before answering.
- You can **see images** your user sends (screenshots, photos, documents) and **search the web** (web_search) for current or external information you don't have. Use web_search for anything factual you're unsure of rather than guessing — but for your user's own data, go to the primary source (Drive, Gmail, Calendar, Asana).
- Produce finished output — a ready-to-send draft, a filled-in table, a reconciled number. Not a summary of what you found.
- **Language**: Communicate with your user in English. Deliver content that is intended for Hebrew audiences (email drafts, documents, summaries of Hebrew data) in Hebrew — but your own conversation, status updates, questions, and explanations are in English.
- For anything that writes to the outside world: use the propose_* tool. Always. No exceptions.
- **When your user sends a block of text or file — that IS the source. Use it. Don't go searching for more.**
- **Reuse what you've already loaded.** If a document is listed under "Open documents — already loaded this session," answer from it directly — don't re-search or re-read it. Only go back to the primary source if the data may have changed since you loaded it, or you never loaded it. Go to the source the first time; reuse it for follow-ups.
- **Cross-reference before reporting anything specific** — names, instruments, emails, numbers, dates. If two sources exist, check both. If they conflict, say so. Never trust a single source for data you're about to act on.
- **If you catch yourself about to report something you didn't verify from a live tool call this session — stop and check first.**
- **Complete multi-step tasks fully before responding.** All 11 items, not 3 with "let me continue."
- **Never narrate what you're about to do.** Call the tool. Speak only with final answers.
- **Never say "let me continue" or "shall I proceed."** Just proceed.

## Proactivity and parallel tasks — your operating mode
You are not a reactive assistant. You run multiple work streams simultaneously.

**Parallel tasks:**
- You hold multiple active tasks at once. When your user interrupts task A with task B, you don't abandon A — you note where A is up to, handle B, then return to A. "גמרתי עם B — נחזור ל-A, עצרנו ב-[מקום]."
- Use remember_fact to save task state when switching: key like "task_huberman_emails", value "עצרנו אחרי שבדקנו 7 מתוך 11, נותרו: אסחאק, ירדן, תמיר."
- **When your user tells you a specific fact** — a date, a name, a schedule, a decision, a number — call remember_fact immediately so it's available in future conversations. Don't rely on session context or the learner to catch it. If your user says "חזרות הסקציה ב-15 ביוני", save it before responding.
- After completing any task, check if there are other active tasks and continue them unprompted.
- Never let a task silently disappear because a new message arrived.

**Driving work forward:**
- When you finish something, propose what comes next immediately. "גמרנו — רוצה שאכין עכשיו את טיוטות המייל ל-7 שנותרו?"
- When your user says "hey" or checks in: surface the most pressing active task first, then status.
- When you notice something actionable mid-task: flag it in one line, don't derail.
- **Always ask before executing** writes. Make it concrete: present the draft, ask "לשלוח?" — not "shall I proceed?"
- **Batching:** draft all similar items together (7 emails = one proposal, one approval).

## Honesty — the single most important rule
your user cannot afford to act on wrong information. Dishonesty of any kind — fabrication, invention, false confirmation, claiming to have done something you didn't — is a critical failure. One instance of this damages trust more than ten good answers can repair.

### The source rule
Every specific claim you make must come from exactly one of two places:
1. A tool result returned **in this session** (visible in your tool outputs)
2. Something your user **explicitly told you** in this conversation

If a claim comes from neither, do not make it. Full stop.

### Recalling the past — never guess, always search
Your context shows only recent messages, but the **full archive of every past conversation** is searchable with the search_history tool. When your user references anything from before — "the dates I gave you", "what we decided about X", "remember when" — **call search_history first**, then answer from what it returns. The record is complete; a half-remembered answer is a failure when the real one is one tool call away. If the search returns nothing, say so plainly — don't fill the gap with a guess.

### Concrete prohibitions — no exceptions

**On URLs and links — absolute prohibition:**
- **Never output a URL or file link unless it came word-for-word from a tool result in this session.**
- This applies to Google Drive, Google Docs, Google Sheets, Gmail, Asana, and every other service. No exceptions.
- If your user asks for a link, call search_drive (or the relevant tool) and return the URL from the result. If the search returns nothing, say so — do not construct, guess, or recall a URL from memory.
- A fabricated URL is worse than no URL. It sends your user to a broken link or the wrong file.

**On file and email contents:**
- Never describe, summarize, list errors in, or quote from any file, email, spreadsheet, or document unless you called a read tool this session and it returned that content.
- If your user tells you "the file has error X" — you can help fix X. You cannot say "I checked it and found X" or add "and also Y." You did not check. Say so if asked.
- Never say **"ראיתי" / "מצאתי" / "עברתי על" / "בדקתי"** unless the tool call proving it is in this session.

**On actions taken:**
- Never say **"שלחתי" / "יצרתי" / "עשיתי" / "נשלח ל-Discord"** unless a tool result confirms it.
- Do the action first. Report it after. In that order.
- If you cannot do something right now, say exactly why — "אין לי גישה ל..." or "הכלי נכשל כי...". Do not promise and vanish. Do not write "רגע" and then do nothing.

**On empty or failed results:**
- If a tool returns nothing, say "לא נמצא כלום." Do not work around it.
- If a tool fails or times out, say so. Do not answer as if it succeeded.

**On uncertainty:**
- "לא יודע" is always correct when you don't have the data. Say it plainly.
- If something is a guess, label it: "אני מניח ש..." Never present a guess as fact.

**Catching yourself is not enough.** A ⚠️ correction after the fact is better than nothing — but the false claim already went out. Prevention is the requirement, not correction.

## Other hard rules
- Missing detail → placeholder [להשלים: ___]. Flag all placeholders.
- No superlatives, no padding, no generic phrases.
- Draft everything; execute nothing without approval.
- Pilot (Year 1, תשפ״ז) vs five-year vision — always separate, never blur.

---

# CONTEXT — about your user (loaded from context.md)

${USER_CONTEXT}
`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_inbox',
    description: 'Read recent Gmail messages. Returns sender, subject, date, snippet.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "from:yoram is:unread". Defaults to unread inbox.' },
        maxResults: { type: 'number', description: 'Max messages to return (default 10).' },
      },
    },
  },
  {
    name: 'read_thread',
    description: 'Read the full body of a Gmail thread by thread/message ID.',
    input_schema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Gmail thread or message ID.' },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'read_email_attachment',
    description: 'Read and parse a file attached to an email. Use the messageId and attachmentId from read_thread\'s attachments list. Returns the extracted text (PDF, Excel .xlsx, and text/CSV supported).',
    input_schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The message ID from read_thread.' },
        attachmentId: { type: 'string', description: 'The attachmentId from the attachments list in read_thread.' },
        filename: { type: 'string', description: 'The attachment filename (used to pick the parser).' },
      },
      required: ['messageId', 'attachmentId'],
    },
  },
  {
    name: 'propose_email',
    description: 'Propose an email draft for your user to approve before sending. Creates a Gmail draft and surfaces an approval card in Discord.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Full email body text.' },
        replyToMessageId: { type: 'string', description: 'Gmail message ID to reply to (optional).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'get_calendar',
    description: 'Get upcoming calendar events from your user\'s personal calendar plus any shared calendars configured, merged and sorted chronologically. Each event includes which calendar it came from.',
    input_schema: {
      type: 'object',
      properties: {
        daysAhead: { type: 'number', description: 'How many days ahead to look (default 14).' },
      },
    },
  },
  {
    name: 'propose_calendar_event',
    description: 'Propose a new calendar event for your user to approve before creating.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 datetime string.' },
        end: { type: 'string', description: 'ISO 8601 datetime string.' },
        location: { type: 'string' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses of attendees.' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'get_tasks',
    description: 'Get your user\'s Asana tasks from the משימות מארק project. Results are sorted: overdue first (flagged overdue:true), then upcoming by due date, then no due date. Always call out overdue tasks explicitly.',
    input_schema: {
      type: 'object',
      properties: {
        completed: { type: 'boolean', description: 'Include completed tasks? Default false.' },
      },
    },
  },
  {
    name: 'find_tasks',
    description: 'Find existing Asana tasks by name keyword and/or section (category). Use this to locate a task before updating it — never ask your user for a GID. Returns only matching tasks with gid, name, due, section.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword from the task name (Hebrew or English). Try the mapped/glossary term if the literal one finds nothing.' },
        section: { type: 'string', description: 'Section/category name to filter by, e.g. "פל״צ", "הוברמן", "יום שליפה".' },
      },
    },
  },
  {
    name: 'list_task_sections',
    description: 'List the sections (categories) of the משימות מארק Asana project, so you can place tasks in the right one.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_task',
    description: 'Propose a new Asana task for your user to approve. your user is ALWAYS set as the assignee automatically. Provide a section so it lands in the right category. Before creating, check find_tasks — if a task for this already exists, propose_task_update instead.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name — clear and specific.' },
        notes: { type: 'string', description: 'Task description / notes.' },
        dueOn: { type: 'string', description: 'Due date as YYYY-MM-DD.' },
        section: { type: 'string', description: 'Category/section name under משימות מארק, e.g. "פל״צ", "הוברמן", "יום שליפה". Use list_task_sections to see options.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'propose_task_update',
    description: 'Propose updating an existing Asana task (change due date, rename, move to a section, mark complete) for your user to approve. your user is always (re)set as assignee. Get the gid from find_tasks first.',
    input_schema: {
      type: 'object',
      properties: {
        gid: { type: 'string', description: 'Asana task GID (from find_tasks).' },
        taskName: { type: 'string', description: 'The task\'s current name (from find_tasks) — shown on the approval card so your user knows which task it is. Always include it.' },
        fields: {
          type: 'object',
          description: 'Fields to update: { "due_on": "2026-06-15" }, { "name": "new title" }, { "section": "פל״צ" }, { "completed": true }. Combine as needed.',
        },
      },
      required: ['gid', 'fields'],
    },
  },
  {
    name: 'search_drive',
    description: 'Search Google Drive for files. Searches both file titles and content. Use key Hebrew or English words from the file name — even partial or approximate names work. When your user refers to a file vaguely ("the Huberman sheet", "the auditions file", "the pilot proposal"), extract the most distinctive keyword(s) and search. Always search before saying a file cannot be found. Return includes real file ID and URL — use those exactly, never construct or guess URLs.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Key word(s) from the file name or content. Use the most distinctive term — e.g. "הוברמן" not "google sheet about huberman".' },
        maxResults: { type: 'number', description: 'Max files to return (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_drive_file',
    description: 'Read a Google Drive file. For spreadsheets, returns all tab names and data. Use sheetName to read a specific tab — e.g. "כלי קשת", "Sheet2", or any partial match. If not specified, reads all tabs.',
    input_schema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Google Drive file ID.' },
        sheetName: { type: 'string', description: 'For spreadsheets: name of the tab to read. Partial match works. Leave blank to read all tabs.' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'propose_doc_append',
    description: 'Propose appending text to a Google Doc for your user to approve before writing.',
    input_schema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Google Doc file ID.' },
        text: { type: 'string', description: 'Text to append.' },
      },
      required: ['fileId', 'text'],
    },
  },
  {
    name: 'sync_context',
    description: 'Save a block of work context from Claude.ai into agent memory so it is available in all future conversations. Use when your user shares a summary, decision, or work product from a Claude.ai session.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short label, e.g. "huberman_applicants", "pilot_proposal_v3".' },
        content: { type: 'string', description: 'The full context, summary, or work product to save.' },
      },
      required: ['topic', 'content'],
    },
  },
  {
    name: 'remember_fact',
    description: 'Store a key fact in persistent memory so it is available in future conversations.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short identifier, e.g. "summer_academy_audition_deadline".' },
        value: { type: 'string', description: 'The fact to remember.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Retrieve all stored memory facts.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_history',
    description: 'Search the FULL archive of past conversations with your user — every message ever exchanged, not just the recent ones in context. Use this whenever your user references something from the past ("remember when we talked about X", "what did I say about Y", "the dates I gave you"). Returns matching messages with their dates. Always search here before saying you don\'t remember something — the record is complete.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Key word(s) to find. All words must appear in the message. Use distinctive terms — names, topics, file names — e.g. "חזרות סקציה" or "Ruti Excel".' },
        limit: { type: 'number', description: 'Max messages to return (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_whatsapp',
    description: 'Read recent WhatsApp messages stored by the bot. Returns the most recent messages with sender name, group (if a group chat), text, and date. Use search to filter by keyword, contact name, or topic.',
    input_schema: {
      type: 'object',
      properties: {
        limit:  { type: 'number',  description: 'Max messages to return (default 50).' },
        search: { type: 'string',  description: 'Optional keyword filter — searches message text.' },
      },
    },
  },
  {
    name: 'ask_mark',
    description: 'Ask your user a question that requires a choice before you can proceed. Shows quick-choice buttons in Discord — your user clicks one and you continue with his answer. Use when you genuinely cannot proceed without his decision (e.g. "which template?", "reply to A or B first?"). Do NOT use for things you can decide yourself. After calling this tool, write one short sentence acknowledging you\'ve asked, then STOP — do not call any more tools.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask your user. Be specific and brief.' },
        options:  {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: '2–4 button labels your user can click. Keep each label short (1–5 words).',
        },
      },
      required: ['question', 'options'],
    },
  },
  // Server-side tool — Anthropic runs the search and returns results inline.
  // No executeTool case needed; it produces server_tool_use blocks, not tool_use.
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

/**
 * Execute a tool call. Returns { result, pendingAction? }.
 * pendingAction is set for propose_* tools — it contains { id, type, previewText, payload }.
 */
// Wrap any tool call with a hard timeout (default 20s, some tools get more)
function withTimeout(promise, toolName, ms = 20000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${toolName} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function executeTool(name, input) {
  switch (name) {
    case 'read_inbox':
      return { result: await withTimeout(gmail.readInbox(input), 'read_inbox') };

    case 'read_thread': {
      const r = await withTimeout(gmail.readThread(input.threadId), 'read_thread');
      mem.cacheDoc(`thread:${input.threadId}`, 'email thread', JSON.stringify(r));
      return { result: r };
    }

    case 'read_email_attachment':
      return { result: await withTimeout(
        gmail.readAttachment(input.messageId, input.attachmentId, input.filename), 'read_email_attachment') };

    case 'propose_email': {
      const draft = await gmail.createDraft(input);
      const id = `email_${Date.now()}`;
      // Draft-only: the bot never sends. Store the full draft so Refine can rewrite it.
      mem.storePending(id, 'email_draft', {
        draftId: draft.draftId,
        to: input.to,
        subject: input.subject,
        body: input.body,
        replyToMessageId: input.replyToMessageId || null,
      });
      const preview = `✏️ **טיוטה נשמרה ב-Gmail** (לא נשלח — תשלח בעצמך)\n**To:** ${input.to}\n**Subject:** ${input.subject}\n\n${input.body}`;
      return { result: { proposed: true, id, note: 'Draft saved to Gmail. Not sent — your user sends it himself.' }, pendingAction: { id, type: 'email_draft', previewText: preview } };
    }

    case 'get_calendar':
      return { result: await withTimeout(calendar.getEvents(input), 'get_calendar') };

    case 'propose_calendar_event': {
      const event = calendar.buildEventProposal(input);
      const id = `cal_${Date.now()}`;
      mem.storePending(id, 'create_event', { event });
      const preview = `📅 **New event**\n**${input.title}**\n${input.start} → ${input.end}${input.location ? `\n📍 ${input.location}` : ''}`;
      return { result: { proposed: true, id }, pendingAction: { id, type: 'create_event', previewText: preview } };
    }

    case 'get_tasks':
      return { result: await withTimeout(asana.getTasks(input), 'get_tasks', 45000) };

    case 'find_tasks':
      return { result: await withTimeout(asana.findTasks(input), 'find_tasks', 45000) };

    case 'list_task_sections':
      return { result: await withTimeout(asana.listSections(), 'list_task_sections', 30000) };

    case 'propose_task': {
      const task = asana.buildTaskProposal(input);
      const id = `task_${Date.now()}`;
      mem.storePending(id, 'create_task', { task });
      const preview = `✅ **משימה חדשה**\n**${input.name}**${input.section ? `\nקטגוריה: ${input.section}` : ''}${input.dueOn ? `\nתאריך יעד: ${input.dueOn}` : ''}\nAssignee: מארק${input.notes ? `\n${input.notes}` : ''}`;
      return { result: { proposed: true, id }, pendingAction: { id, type: 'create_task', previewText: preview } };
    }

    case 'propose_task_update': {
      const id = `taskup_${Date.now()}`;
      mem.storePending(id, 'update_task', { gid: input.gid, fields: input.fields });
      // Resolve a human-readable task name: prefer what the agent passed, else fetch it.
      let taskName = input.taskName;
      if (!taskName) {
        try { taskName = (await asana.getTask(input.gid))?.name; } catch {}
      }
      const f = input.fields || {};
      const fmtDate = (d) => { const [y, m, day] = String(d).split('-'); return `${+day}.${+m}.${String(y).slice(2)}`; };
      const changes = [];
      if (f.due_on) changes.push(`תאריך יעד → ${fmtDate(f.due_on)}`);
      if (f.name) changes.push(`שם → "${f.name}"`);
      if (f.section) changes.push(`קטגוריה → ${f.section}`);
      if (f.completed === true) changes.push('סימון כהושלם ✓');
      if (f.notes) changes.push('עדכון הערות');
      const changeText = changes.join(' · ') || JSON.stringify(f);
      const preview = `✏️ **עדכון משימה**\n**${taskName || `GID ${input.gid}`}**\n${changeText}`;
      return { result: { proposed: true, id }, pendingAction: { id, type: 'update_task', previewText: preview } };
    }

    case 'search_drive': {
      const query = input.query || '';
      const lowerQ = query.toLowerCase();
      const terms = lowerQ.split(/\s+/).filter(t => t.length > 1);

      // Check locally cached file IDs first — files previously read are found instantly
      const cachedHits = mem.recallAll()
        .filter(f => f.key.startsWith('drive_id_') && f.value !== '__deleted__')
        .map(f => { try { return JSON.parse(f.value); } catch { return null; } })
        .filter(f => f && f.name && terms.some(t => f.name.toLowerCase().includes(t)));

      const apiResults = await withTimeout(drive.searchFiles(query, input.maxResults || 10), 'search_drive');

      // Cached hits first (most trusted), then API results, deduped
      const seen = new Set(cachedHits.map(f => f.id));
      const merged = [
        ...cachedHits,
        ...apiResults.filter(f => !seen.has(f.id)),
      ].slice(0, input.maxResults || 10);

      return { result: merged };
    }

    case 'read_drive_file': {
      const r = await withTimeout(drive.readFile(input.fileId, input.sheetName), 'read_drive_file', 45000);
      mem.cacheDoc(`drive:${input.fileId}`, r.name, JSON.stringify(r));
      // Persist file ID → name mapping for instant future lookups
      if (r.name) {
        const idKey = `drive_id_${r.name.replace(/[^a-z0-9א-ת]/gi, '_').slice(0, 50)}`;
        mem.remember(idKey, JSON.stringify({ id: input.fileId, name: r.name, mimeType: r.mimeType || '' }));
      }
      return { result: r };
    }

    case 'propose_doc_append': {
      const id = `doc_${Date.now()}`;
      mem.storePending(id, 'append_doc', { fileId: input.fileId, text: input.text });
      const preview = `📝 **Append to doc**\nFile: ${input.fileId}\n\n${input.text.slice(0, 500)}`;
      return { result: { proposed: true, id }, pendingAction: { id, type: 'append_doc', previewText: preview } };
    }

    case 'sync_context':
      mem.remember(`context_${input.topic}`, input.content);
      return { result: { synced: true, topic: input.topic } };

    case 'remember_fact':
      mem.remember(input.key, input.value);
      return { result: { remembered: true, key: input.key } };

    case 'recall_memory':
      return { result: mem.recallAll() };

    case 'read_whatsapp': {
      const msgs = input.search
        ? mem.searchWhatsAppMessages(input.search, input.limit || 30)
        : mem.getWhatsAppMessages({ limit: input.limit || 50 });
      return { result: msgs.length ? msgs : { found: 0, note: 'No WhatsApp messages stored yet.' } };
    }

    case 'ask_mark': {
      const id = `ask_${Date.now()}`;
      const { question, options } = input;
      mem.storePending(id, 'ask_mark', { question, options });
      const preview = `❓ **${question}**\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
      return {
        result: { asked: true, id, note: 'Question sent to your user as Discord buttons. Write one sentence confirming you have asked, then stop — do not call any more tools until he clicks.' },
        pendingAction: { id, type: 'ask_mark', previewText: preview, payload: { question, options } },
      };
    }

    case 'search_history': {
      const hits = mem.searchMessages(input.query, input.limit || 20);
      const formatted = hits.map(h => ({
        date: new Date(h.ts * 1000).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }),
        who: h.role === 'user' ? 'מארק' : 'הסוכן',
        text: h.content.slice(0, 1500),
      }));
      return { result: formatted };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}

// ── Main agentic loop ─────────────────────────────────────────────────────────

/**
 * Run one turn of the agent.
 * @param {string} userMessage  - What your user typed
 * @param {function} onUpdate   - Called with interim status strings during tool use
 * @returns {{ text: string, pendingActions: Array }}
 */
// Token estimator: Hebrew ~1.5 chars/token (2-byte UTF-8 glyphs), English ~4, mixed ~2.
// Use /2 to be conservative — better to trim too much than overflow.
function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text : JSON.stringify(text)).length / 2);
}

// Strip thinking blocks from all but the most recent assistant turn.
// Per Anthropic docs: safe to omit thinking from older turns to reduce context length.
function stripOldThinkingBlocks(messages) {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }
  return messages.map((m, i) => {
    if (m.role !== 'assistant' || i === lastAssistantIdx || !Array.isArray(m.content)) return m;
    const stripped = m.content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    return stripped.length > 0 ? { ...m, content: stripped } : m;
  });
}

// Trim message history so system + messages stay under maxTokens.
// Always keeps at least the last 10 messages.
function trimToTokenBudget(messages, systemText, maxTokens = 90000) {
  let msgs = [...messages];
  while (msgs.length > 10) {
    const total = estimateTokens(systemText) +
      msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (total <= maxTokens) break;
    msgs = msgs.slice(2); // drop oldest pair
  }
  if (msgs.length < messages.length) {
    console.log(`[token-trim] Reduced history ${messages.length} → ${msgs.length} messages`);
  }
  return msgs;
}

// Prepare messages for an API call: strip old thinking blocks then trim to budget.
function prepareForApi(messages, systemText) {
  return trimToTokenBudget(stripOldThinkingBlocks(messages), systemText);
}

// web_search is a paid server-side tool. If the account doesn't have it enabled,
// the API rejects the request — which would otherwise break every message.
// This wrapper disables web_search for the rest of the process on first rejection
// and retries without it, so the bot keeps working either way.
let webSearchAvailable = true;
const stripWebSearch = p => ({
  ...p,
  tools: p.tools.filter(t => t.type !== 'web_search_20250305'),
});

// Stream a model turn, forwarding text deltas to onStream(delta) as they arrive,
// and return the final assembled message. Also carries the web_search fallback:
// if the account rejects web_search, disable it for the process and retry.
async function createMessage(params, onStream) {
  const runStream = async p => {
    const stream = client.messages.stream(p);
    if (onStream) stream.on('text', delta => { try { onStream(delta); } catch {} });
    return await stream.finalMessage();
  };
  if (!webSearchAvailable) params = stripWebSearch(params);
  try {
    return await runStream(params);
  } catch (err) {
    if (webSearchAvailable && /web.?search|search_20250305/i.test(err.message || '')) {
      console.error('[web_search] API rejected it — disabling for this process:', err.message);
      webSearchAvailable = false;
      return await runStream(stripWebSearch(params));
    }
    throw err;
  }
}

async function runAgent(userMessage, onUpdate = () => {}, images = [], onStream = null) {
  mem.addMessage('user', userMessage);

  const memory = mem.recallAll().filter(f => f.value !== '__deleted__' && f.value !== '__resolved__');
  const openThreads = memory.filter(f => f.key.startsWith('learned_open_'));
  const learnedPrefs = memory.filter(f => f.key.startsWith('learned_pref_'));
  const learnedFacts = memory.filter(f => f.key.startsWith('learned_fact_') || f.key.startsWith('fact_'));
  const learnedOther = memory.filter(f => f.key.startsWith('learned_') && !f.key.startsWith('learned_open_') && !f.key.startsWith('learned_pref_') && !f.key.startsWith('learned_fact_'));
  const syncedContext = memory.filter(f => f.key.startsWith('context_'));
  const sessionSummaries = memory.filter(f => f.key.startsWith('session_summary_'));
  const convLog = memory
    .filter(f => f.key.startsWith('conv_'))
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, 20);
  const otherFacts = memory.filter(f => !f.key.startsWith('learned_') && !f.key.startsWith('context_') && !f.key.startsWith('session_summary_') && !f.key.startsWith('fact_') && !f.key.startsWith('conv_'));

  const fmtConvDate = key => {
    const ts = parseInt(key.replace('conv_', ''), 10);
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
  };

  // Current Israel time — injected per-turn so the agent always knows "now".
  const nowIsrael = new Date().toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // Working memory: documents already loaded recently this session.
  const recentDocs = mem.getRecentDocs({ maxAgeMin: 30, limit: 3 });

  const memBlock = [
    `\n\n## Current time\n${nowIsrael} (Israel time)`,
    openThreads.length
      ? '\n\n## Open threads — unfinished business (be proactive about these)\n' +
        openThreads.slice(0, 10).map(f => `- ${f.value}`).join('\n') +
        '\nWhen relevant, surface these and offer to continue. When one is completed, the learner will mark it resolved.'
      : '',
    syncedContext.length
      ? '\n\n## Synced work context from Claude.ai sessions\n' +
        syncedContext.map(f => `### ${f.key.replace('context_', '')}\n${f.value.slice(0, 3000)}`).join('\n\n')
      : '',
    learnedPrefs.length
      ? '\n\n## your user\'s preferences (apply always)\n' +
        learnedPrefs.map(f => `- ${f.value}`).join('\n')
      : '',
    convLog.length
      ? '\n\n## Conversation history (most recent first)\nUse this when your user references a past conversation. Be specific — "on [date] we discussed X."\n' +
        convLog.map(f => `- [${fmtConvDate(f.key)}] ${f.value}`).join('\n')
      : '',
    learnedFacts.length
      ? '\n\n## Facts your user has shared (treat as ground truth)\n' +
        learnedFacts.map(f => `- ${f.value}`).join('\n')
      : '',
    learnedOther.length
      ? '\n\n## Remembered facts\n' + learnedOther.map(f => `- ${f.value}`).join('\n')
      : '',
    sessionSummaries.length
      ? '\n\n## Earlier in this session (compressed)\n' +
        sessionSummaries.slice(-2).map(f => f.value).join('\n---\n')
      : '',
    otherFacts.length
      ? '\n\n## Other memory\n' + otherFacts.map(f => `- ${f.key}: ${f.value}`).join('\n')
      : '',
    recentDocs.length
      ? '\n\n## Open documents — already loaded this session\n' +
        'You ALREADY have these in front of you. Answer follow-up questions directly from them — do NOT re-search Drive or re-read unless the underlying data may have changed since you loaded it.\n\n' +
        recentDocs.map(d => `### ${d.name || d.key} (key: ${d.key})\n${d.content}`).join('\n\n')
      : '',
  ].join('');

  // Build the running message thread, trimmed to fit within token budget
  const runningMessages = trimToTokenBudget(mem.getHistory(30), SYSTEM + memBlock);

  // Attach any images to the current (last) user turn so Opus can see them.
  // Done after trimming — image bytes shouldn't drive the text trim heuristic.
  if (images.length && runningMessages.length) {
    const last = runningMessages[runningMessages.length - 1];
    if (last.role === 'user') {
      const textPart = typeof last.content === 'string' ? last.content : userMessage;
      last.content = [
        ...images.map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })),
        { type: 'text', text: textPart || '(no text)' },
      ];
    }
  }

  const pendingActions = [];

  let response = await createMessage({
    model: MODEL,
    max_tokens: 16000,
    // thinking removed — adds 3-5s latency on every call including simple lookups,
    // and 3000-token budget was too small to help on complex ones anyway.
    system: SYSTEM + memBlock,
    tools: TOOLS,
    messages: runningMessages,
  }, onStream);

  // Agentic loop — accumulate tool calls and results properly across iterations.
  // Cap is generous so complex multi-step work (read several files, cross-reference,
  // draft) can complete; context is trimmed every call so this won't overflow tokens.
  let iterations = 0;
  while ((response.stop_reason === 'tool_use' || response.stop_reason === 'pause_turn') && iterations < 20) {
    iterations++;

    // pause_turn: a server-side tool (web_search) ran long and the turn was
    // paused. Resume by echoing the partial turn back — no tool_result needed,
    // the server already has the results inline.
    if (response.stop_reason === 'pause_turn') {
      runningMessages.push({ role: 'assistant', content: response.content });
      response = await createMessage({
        model: MODEL,
        max_tokens: 16000,
        // thinking removed — adds 3-5s latency on every call including simple lookups,
    // and 3000-token budget was too small to help on complex ones anyway.
        system: SYSTEM + memBlock,
        tools: TOOLS,
        messages: prepareForApi(runningMessages, SYSTEM + memBlock),
      }, onStream);
      continue;
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const tu of toolUses) {
      const label = {
        read_inbox: '📧 reading inbox…',
        read_thread: '📧 reading thread…',
        read_email_attachment: '📎 reading attachment…',
        propose_email: '📧 drafting email…',
        get_calendar: '📅 checking calendar…',
        propose_calendar_event: '📅 preparing event…',
        get_tasks: '✅ checking Asana…',
        find_tasks: '✅ searching tasks…',
        list_task_sections: '✅ reading categories…',
        propose_task: '✅ preparing task…',
        propose_task_update: '✅ preparing update…',
        search_drive: '🔍 searching Drive…',
        read_drive_file: '📄 reading file…',
        propose_doc_append: '📝 preparing edit…',
        remember_fact: '🧠 saving to memory…',
        recall_memory: '🧠 recalling memory…',
        read_whatsapp:  '💬 reading WhatsApp…',
        search_history: '🔎 searching past conversations…',
        sync_context: '🧠 saving context…',
        ask_mark: '❓ asking your user…',
      }[tu.name] || `🔧 ${tu.name}…`;
      onUpdate(label);

      let result;
      try {
        const outcome = await executeTool(tu.name, tu.input);
        const raw = outcome.result;
        // Make empty results explicit so Claude cannot hallucinate over them
        if (Array.isArray(raw) && raw.length === 0) {
          result = JSON.stringify({ found: 0, results: [], note: 'No results found — do not invent any.' });
        } else {
          result = JSON.stringify(raw);
        }
        // Cap tool results to prevent single large responses from blowing the context
        if (result.length > 12000) {
          result = result.slice(0, 12000) + '… [truncated]';
        }
        if (outcome.pendingAction) pendingActions.push(outcome.pendingAction);
      } catch (err) {
        result = JSON.stringify({ error: err.message, note: 'Tool failed — do not guess or invent results.' });
        console.error(`[tool:${tu.name}]`, err.message);
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }

    // Accumulate: add this assistant turn + results to the running thread
    runningMessages.push({ role: 'assistant', content: response.content });
    runningMessages.push({ role: 'user', content: toolResults });

    response = await createMessage({
      model: MODEL,
      max_tokens: 16000,
      // thinking removed — adds 3-5s latency on every call including simple lookups,
    // and 3000-token budget was too small to help on complex ones anyway.
      system: SYSTEM + memBlock,
      tools: TOOLS,
      // Strip old thinking blocks + trim before each call to prevent accumulation
      messages: prepareForApi(runningMessages, SYSTEM + memBlock),
    }, onStream);
  }

  let text = response.content.find(b => b.type === 'text')?.text || '';

  // If Claude returned no text (e.g. only tool calls with no final answer), ask it to summarise
  if (!text.trim() && iterations > 0) {
    // If last response was tool_use (hit iteration cap), pushing it without a tool_result
    // would produce an invalid message sequence the API rejects.
    // Use a placeholder text turn instead so the chain stays valid.
    const assistantContent = response.stop_reason === 'tool_use'
      ? [{ type: 'text', text: '...' }]
      : (response.content.length ? response.content : [{ type: 'text', text: '' }]);
    runningMessages.push({ role: 'assistant', content: assistantContent });
    runningMessages.push({ role: 'user', content: [{ type: 'text', text: 'ענה בבקשה.' }] });
    const fallback = await createMessage({
      model: MODEL,
      max_tokens: 16000,
      // thinking removed — adds 3-5s latency on every call including simple lookups,
    // and 3000-token budget was too small to help on complex ones anyway.
      system: SYSTEM + memBlock,
      tools: TOOLS,
      messages: prepareForApi(runningMessages, SYSTEM + memBlock),
    }, onStream);
    text = fallback.content.find(b => b.type === 'text')?.text || '⚠️ לא הצלחתי לסיים את המשימה.';
  }

  mem.addMessage('assistant', text);

  // Fire-and-forget reflection — learn from this exchange
  const conversationCount = mem.getMessageCount();
  reflect(userMessage, text).then(() => {
    // Consolidate every ~20 conversations
    if (conversationCount % 40 === 0) consolidate();
  });

  return { text, pendingActions };
}

// Rewrite an email draft per your user's instruction (used by the Refine button).
// Returns { subject, body }. Never sends — caller updates the Gmail draft.
async function refineDraft(original, instruction) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: 'You revise an email draft per an instruction. Keep the same language as the original draft. Return ONLY valid JSON: {"subject":"...","body":"..."} — no other text, no markdown fences.',
    messages: [{
      role: 'user',
      content: `Original draft:\nTo: ${original.to}\nSubject: ${original.subject}\n\n${original.body}\n\nInstruction: ${instruction}`,
    }],
  });
  const text = resp.content.find(b => b.type === 'text')?.text || '';
  const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const parsed = JSON.parse(json);
  return {
    subject: parsed.subject ?? original.subject,
    body: parsed.body ?? original.body,
  };
}

module.exports = { runAgent, refineDraft };
