const https = require('https');

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const MARK_PROJECT_GID = process.env.ASANA_PROJECT_GID || ''; // your user's main task project (set in Railway vars)

function asanaRequest(method, path, body = null, attempt = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'app.asana.com',
      path: `/api/1.0${path}`,
      method,
      headers: {
        Authorization: `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', async () => {
        // Rate limited — wait per Retry-After and retry (up to 3 attempts)
        if (res.statusCode === 429 && attempt < 3) {
          const wait = (parseInt(res.headers['retry-after'], 10) || 2) * 1000;
          await new Promise(r => setTimeout(r, wait));
          try { resolve(await asanaRequest(method, path, body, attempt + 1)); }
          catch (e) { reject(e); }
          return;
        }
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { return reject(new Error(`Asana ${res.statusCode}: ${String(data).slice(0, 150)}`)); }
        // Asana returns { errors: [...] } on failure — surface it clearly
        if (parsed.errors) {
          return reject(new Error(parsed.errors.map(e => e.message).join('; ') || `Asana ${res.statusCode}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getTasks({ completed = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const tasks = [];

  // Use /projects/{gid}/tasks — returns all tasks across all sections.
  // Paginate until no next_page token.
  let path = `/projects/${MARK_PROJECT_GID}/tasks?opt_fields=name,due_on,notes,completed,memberships.section.name&limit=100&completed=${completed}`;
  while (path) {
    const res = await asanaRequest('GET', path);
    for (const t of res.data || []) {
      // Asana represents section headers as tasks with no name — skip them.
      if (!t.name || !t.name.trim()) continue;
      const section = t.memberships?.[0]?.section?.name || null;
      tasks.push({
        gid: t.gid,
        name: t.name,
        due: t.due_on,
        overdue: !t.completed && !!t.due_on && t.due_on < today,
        completed: t.completed,
        section,
        notes: t.notes,
      });
    }
    path = res.next_page?.path || null;
  }

  // Sort: overdue first, then upcoming by due date, then no due date
  return tasks.sort((a, b) => {
    if (a.overdue && !b.overdue) return -1;
    if (!a.overdue && b.overdue) return 1;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return 0;
  });
}

async function getTask(gid) {
  const res = await asanaRequest('GET', `/tasks/${gid}?opt_fields=name,due_on,notes,completed,subtasks`);
  return res.data;
}

// List the sections (categories) of the משימות מארק project.
async function listSections() {
  const res = await asanaRequest('GET', `/projects/${MARK_PROJECT_GID}/sections?opt_fields=name`);
  return (res.data || []).map(s => ({ gid: s.gid, name: s.name }));
}

// Resolve a section name (fuzzy) to its gid. Returns null if no match.
async function resolveSection(sectionName) {
  if (!sectionName) return null;
  const sections = await listSections();
  const want = sectionName.toLowerCase().trim();
  const m = sections.find(s => s.name?.toLowerCase().trim() === want)
        || sections.find(s => s.name?.toLowerCase().includes(want) || want.includes(s.name?.toLowerCase()));
  return m ? m.gid : null;
}

// Find existing tasks by name keyword and/or section — returns only matches (small list).
async function findTasks({ query, section } = {}) {
  const all = await getTasks({ completed: false });
  const q = (query || '').toLowerCase().trim();
  const s = (section || '').toLowerCase().trim();
  return all.filter(t => {
    const nameOk = !q || (t.name && t.name.toLowerCase().includes(q));
    const secOk = !s || (t.section && t.section.toLowerCase().includes(s));
    return nameOk && secOk;
  }).map(t => ({ gid: t.gid, name: t.name, due: t.due, section: t.section, overdue: t.overdue }));
}

/**
 * Build a create proposal. Always assigns the task to Mark ('me' = token owner).
 * `section` is a category name; resolved to a section gid at create time.
 */
function buildTaskProposal({ name, notes, dueOn, section }) {
  return {
    data: {
      name,
      notes: notes || '',
      due_on: dueOn || null,
      assignee: 'me',                 // Mark is always the assignee
      projects: [MARK_PROJECT_GID],
    },
    section: section || null,
  };
}

/** Only called after explicit approval. Places the task in its section if given. */
async function createTask(taskBody) {
  const { section, ...body } = taskBody;
  const res = await asanaRequest('POST', '/tasks', body);
  if (!res.data) throw new Error('Asana create returned no task data');
  const gid = res.data.gid;
  if (section) {
    const sectionGid = await resolveSection(section);
    if (sectionGid) {
      await asanaRequest('POST', `/sections/${sectionGid}/addTask`, { data: { task: gid } });
    }
  }
  return { created: true, gid, name: res.data.name, section: section || null };
}

/** Returns an update proposal — shown to user for approval. Always (re)assigns to Mark. */
function buildUpdateProposal(gid, fields) {
  const data = { assignee: 'me', ...fields };
  delete data.section; // section moves are handled separately
  return { gid, data, section: fields.section || null };
}

/** Only called after explicit approval. */
async function updateTask(gid, fields) {
  const { section, ...rest } = fields;
  const data = { assignee: 'me', ...rest };
  const res = await asanaRequest('PUT', `/tasks/${gid}`, { data });
  if (!res.data) throw new Error('Asana update returned no task data');
  if (section) {
    const sectionGid = await resolveSection(section);
    if (sectionGid) {
      await asanaRequest('POST', `/sections/${sectionGid}/addTask`, { data: { task: gid } });
    }
  }
  return { updated: true, gid, name: res.data.name };
}

module.exports = { getTasks, getTask, findTasks, listSections, buildTaskProposal, createTask, buildUpdateProposal, updateTask };
