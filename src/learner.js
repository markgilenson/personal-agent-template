/**
 * Post-conversation learner.
 * After each exchange, runs a lightweight reflection pass to extract
 * anything worth remembering about Mark's preferences and working style.
 * Uses Haiku (fast + cheap) — not the full Sonnet loop.
 */

const Anthropic = require('@anthropic-ai/sdk');
const mem = require('./memory');

// Jaccard-style word overlap: what fraction of the smaller set's words appear in the larger.
function wordOverlap(a, b) {
  const words = s => new Set(String(s).toLowerCase().split(/\W+/).filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  const smaller = wa.size <= wb.size ? wa : wb;
  const larger  = wa.size <= wb.size ? wb : wa;
  if (!smaller.size) return 0;
  let shared = 0;
  for (const w of smaller) if (larger.has(w)) shared++;
  return shared / smaller.size;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REFLECTION_PROMPT = `You are observing a conversation between the user and their personal assistant.
Your job: extract two types of things.

TYPE 1 — Style/personality (key prefix: "pref_"):
- Mark correcting or rephrasing a response — what did he change and why?
- Tone corrections: was the agent too formal, too wordy, too soft?
- Language preferences: when does he prefer Hebrew vs English?
- Length: did he seem impatient with a long reply? Did he ask for more detail?
- Specific phrases or words Mark uses that the agent should adopt
- Things Mark clearly finds annoying (e.g. generic openings, unnecessary caveats)
- His energy in this conversation — rushed? focused? casual? Match it next time.
Do NOT extract JMC institutional facts (already in system prompt).

TYPE 2 — Open threads and task state (key prefix: "open_"):
- Tasks started but not finished (e.g. "checked 7/11 Huberman names, 4 remaining: X, Y, Z, W")
- Task switches: if Mark interrupted task A with task B, save where A was paused
- Questions not fully answered
- Work left for next time
Be specific about what's done and what's left — not "checking emails" but "checked 3/11, stopped at אסחאק סלים"
When an open thread is RESOLVED, prefix with "RESOLVED_open_" so the caller can delete it.

TYPE 3 — Important facts Mark shares (key prefix: "fact_"):
- Specific dates, times, schedules Mark mentions (e.g. rehearsal dates, audition schedule, deadlines)
- Names, roles, contact info of people Mark references that aren't already known institutional context
- Decisions made ("הוחלט ש...", "יהיה X", "ביטלנו Y")
- Numbers that matter: budget figures, room numbers, counts, fees
- Any specific factual information Mark shares that he might need recalled in a future conversation
Do NOT extract things that are standard JMC institutional facts.
Use a short descriptive key, e.g. "fact_section_rehearsal_schedule", "fact_ruti_contract_fee".

TYPE 4 — Conversation log entry (key: exactly "conv_log"):
- Write a 1-2 sentence summary of what was discussed/done in this exchange
- Be specific: names, file names, topics, decisions, dates mentioned
- This becomes the cross-session memory log — future Mark will ask "remember when we talked about X?" and this is what the agent will see
- Only create this if there was substantive content (skip trivial one-word exchanges)
- Example: "Discussed section rehearsal schedule — Mark confirmed 10.6, 22.6, 29.6, 3.7. Saved to memory."
- Example: "Fixed Gmail attachment bug — switched to flexible filename matching. Agent was hallucinating Drive URLs, added hard prohibition."

Return a JSON array. Each item: { "key": "prefix_identifier", "value": "description of what's open or what was learned" }
Return [] if nothing to extract.
Only return the JSON — no other text.`;

/**
 * Run reflection after a conversation exchange.
 * @param {string} userMessage
 * @param {string} assistantReply
 */
async function reflect(userMessage, assistantReply) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `${REFLECTION_PROMPT}

---
User: ${userMessage}
Assistant: ${assistantReply}
---

What should be remembered?`,
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text')?.text?.trim() || '[]';

    // Strip markdown fences if present
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const learned = JSON.parse(json);

    if (!Array.isArray(learned) || learned.length === 0) return;

    // Pre-load existing memory for dedup check
    const existingMemory = mem.recallAll().filter(f => f.value !== '__deleted__' && f.value !== '__resolved__');

    for (const item of learned) {
      if (!item.key || !item.value) continue;

      if (item.key.startsWith('RESOLVED_open_')) {
        const resolvedKey = item.key.replace('RESOLVED_', '');
        mem.remember(resolvedKey, '__resolved__');
        console.log(`[learner] resolved: ${resolvedKey}`);
      } else if (item.key === 'conv_log') {
        // Timestamped conversation log entry — keep last 30
        const tsKey = `conv_${Date.now()}`;
        mem.remember(tsKey, item.value);
        console.log(`[learner] conv log: ${item.value}`);
        // Prune oldest beyond 30
        const allConv = mem.recallAll()
          .filter(f => f.key.startsWith('conv_') && f.value !== '__deleted__')
          .sort((a, b) => a.key.localeCompare(b.key));
        while (allConv.length > 30) {
          mem.remember(allConv.shift().key, '__deleted__');
        }
      } else {
        const fullKey = `learned_${item.key}`;
        // Dedup: skip if ≥60% word overlap with any existing fact of the same prefix
        const prefix = item.key.split('_')[0];
        const existing = existingMemory.filter(f => f.key.startsWith(`learned_${prefix}_`));
        if (existing.some(f => wordOverlap(f.value, item.value) >= 0.6)) {
          console.log(`[learner] dedup skip (≥60% overlap): ${item.key}`);
          continue;
        }
        mem.remember(fullKey, item.value);
        console.log(`[learner] saved: ${item.key} = ${item.value}`);
      }
    }
  } catch (err) {
    // Reflection is best-effort — never crash the main flow
    console.error('[learner] reflection error:', err.message);
  }
}

/**
 * Periodic consolidation — merges duplicate/redundant learned facts.
 * Run occasionally (e.g. every 20 conversations).
 */
async function consolidate() {
  try {
    const facts = mem.recallAll().filter(f => f.key.startsWith('learned_'));
    if (facts.length < 5) return;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Here are learned facts about Mark's preferences. Merge duplicates, remove contradictions (keep the most recent/specific), and tighten the wording.
Return a JSON array: [{ "key": "short_identifier", "value": "the fact" }]
Only return JSON.

Facts:
${facts.map(f => `${f.key}: ${f.value}`).join('\n')}`,
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text')?.text?.trim() || '[]';
    const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const consolidated = JSON.parse(json);

    if (!Array.isArray(consolidated) || consolidated.length === 0) return;

    // Clear old learned facts and write consolidated ones
    for (const fact of facts) {
      mem.remember(fact.key, '__deleted__');
    }
    for (const item of consolidated) {
      if (item.key && item.value) {
        mem.remember(`learned_${item.key}`, item.value);
      }
    }

    console.log(`[learner] consolidated ${facts.length} facts → ${consolidated.length}`);
  } catch (err) {
    console.error('[learner] consolidation error:', err.message);
  }
}

module.exports = { reflect, consolidate };
