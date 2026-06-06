const { google } = require('googleapis');
const { getAuth } = require('../google-auth');

async function searchFiles(query, maxResults = 10) {
  const drive = google.drive({ version: 'v3', auth: getAuth() });

  // Split into meaningful words (ignore short stop-words)
  const words = query.split(/\s+/).filter(w => w.length > 1);
  const escaped = query.replace(/'/g, "\\'");

  // Build all search queries: full phrase + each individual word (title + fulltext)
  const queries = [
    `name contains '${escaped}' and trashed=false`,
    `fullText contains '${escaped}' and trashed=false`,
    ...words.map(w => `name contains '${w.replace(/'/g, "\\'")}' and trashed=false`),
  ];

  // Run all in parallel
  const allResults = await Promise.all(
    queries.map(q =>
      drive.files.list({
        q,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
        pageSize: maxResults,
        orderBy: 'modifiedTime desc',
      }).then(r => r.data.files || []).catch(() => [])
    )
  );

  // Merge, deduplicate, and score by frequency of appearance (more query hits = more relevant)
  const scores = {};
  const fileMap = {};
  for (const batch of allResults) {
    for (const f of batch) {
      scores[f.id] = (scores[f.id] || 0) + 1;
      fileMap[f.id] = f;
    }
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])          // highest score first
    .slice(0, maxResults)
    .map(([id]) => ({
      id,
      name: fileMap[id].name,
      mimeType: fileMap[id].mimeType,
      modifiedTime: fileMap[id].modifiedTime,
      url: fileMap[id].webViewLink,
    }));
}

async function readFile(fileId, sheetName = null) {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType' });
  const mimeType = meta.data.mimeType;

  if (mimeType === 'application/vnd.google-apps.document') {
    const docs = google.docs({ version: 'v1', auth });
    const doc = await docs.documents.get({ documentId: fileId });
    const text = doc.data.body.content
      .flatMap(el => el.paragraph?.elements || [])
      .map(el => el.textRun?.content || '')
      .join('');
    return { name: meta.data.name, mimeType, text: text.slice(0, 8000) };
  }

  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const sheets = google.sheets({ version: 'v4', auth });

    // First get sheet metadata to know all tab names
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: fileId });
    const allSheets = spreadsheet.data.sheets.map(s => s.properties.title);

    // Determine which tab(s) to read
    let tabsToRead;
    if (sheetName) {
      // Fuzzy match the requested sheet name
      const match = allSheets.find(s =>
        s.toLowerCase().includes(sheetName.toLowerCase()) ||
        sheetName.toLowerCase().includes(s.toLowerCase())
      ) || allSheets[0];
      tabsToRead = [match];
    } else {
      // Read all tabs (up to 5)
      tabsToRead = allSheets.slice(0, 5);
    }

    const result = { name: meta.data.name, mimeType, tabs: allSheets, sheets: {} };
    const fetched = await Promise.all(
      tabsToRead.map(tab =>
        sheets.spreadsheets.values.get({ spreadsheetId: fileId, range: `'${tab}'!A1:Z200` })
          .then(sh => ({ tab, values: sh.data.values || [] }))
          .catch(() => ({ tab, values: [] }))
      )
    );
    for (const { tab, values } of fetched) result.sheets[tab] = values;
    return result;
  }

  // Native binary files (PDF, Excel, Word) — download as binary and parse
  const downloadBinary = async () => {
    const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data);
  };

  if (mimeType === 'application/pdf') {
    const pdfParse = require('pdf-parse/lib/pdf-parse');
    try {
      const buf = await downloadBinary();
      const parsed = await pdfParse(buf);
      if (!parsed.text || !parsed.text.trim()) {
        return { name: meta.data.name, mimeType, text: '', note: 'PDF appears to be image-based (scanned) — no extractable text. Mark needs to share a text version or copy-paste the content.' };
      }
      return { name: meta.data.name, mimeType, text: parsed.text.slice(0, 12000) };
    } catch (err) {
      return { name: meta.data.name, mimeType, text: '', error: `PDF parse failed: ${err.message}` };
    }
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || /\.xlsx$/i.test(meta.data.name || '')) {
    const { xlsxToText } = require('../xlsx');
    const buf = await downloadBinary();
    return { name: meta.data.name, mimeType, text: await xlsxToText(buf) };
  }

  // Google-Workspace export (Docs, Slides, etc.) or plain text files
  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' }
  ).catch(() => null);

  if (res) {
    return { name: meta.data.name, mimeType, text: String(res.data).slice(0, 8000) };
  }

  // Last resort: try downloading as-is and reading as UTF-8
  try {
    const buf = await downloadBinary();
    return { name: meta.data.name, mimeType, text: buf.toString('utf-8').slice(0, 8000) };
  } catch {
    return { name: meta.data.name, mimeType, text: `(unsupported file type: ${mimeType})` };
  }
}

/** Returns proposal — shown to user before writing. */
function buildDocUpdateProposal(fileId, content) {
  return { fileId, content };
}

/** Only called after explicit approval. */
async function appendToDoc(fileId, text) {
  const docs = google.docs({ version: 'v1', auth: getAuth() });
  const doc = await docs.documents.get({ documentId: fileId });
  const endIndex = doc.data.body.content.at(-1).endIndex - 1;
  await docs.documents.batchUpdate({
    documentId: fileId,
    requestBody: {
      requests: [{ insertText: { location: { index: endIndex }, text: '\n' + text } }],
    },
  });
  return { appended: true, fileId };
}

module.exports = { searchFiles, readFile, buildDocUpdateProposal, appendToDoc };
