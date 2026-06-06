/**
 * Unified file parser — shared by Discord uploads (index.js) and Gmail
 * attachments (tools/gmail.js readAttachment). Give it a Buffer + filename
 * (+ optional mimeType); get back { text } | { note } | { error }.
 *
 * Images are NOT handled here — Discord uploads route images to the vision
 * model directly; for email image attachments we return a note.
 */

const TEXT_RE = /\.(txt|md|mdx|csv|tsv|json|jsonl|ndjson|js|mjs|cjs|jsx|ts|tsx|html?|css|scss|sass|less|xml|svg|ya?ml|toml|ini|env|cfg|conf|properties|py|rb|go|java|c|cpp|cc|h|hpp|cs|rs|swift|kt|php|sh|bash|zsh|fish|ps1|r|sql|graphql|gql|proto|rst|tex|org|vue|svelte|astro|log)$/i;

async function parseFileToText(buffer, filename = '', mimeType = '', maxChars = 12000) {
  const name = (filename || '').toLowerCase();
  const mt = mimeType || '';

  try {
    // ── PDF ──
    if (mt === 'application/pdf' || name.endsWith('.pdf')) {
      const pdfParse = require('pdf-parse'); // main export (works in v1.1.1; deep path is blocked in v2)
      const parsed = await pdfParse(buffer);
      const text = (parsed.text || '').trim();
      if (!text) return { note: `${filename}: סרוק (תמונות בלבד, אין שכבת טקסט לחלץ).` };
      return { text: text.slice(0, maxChars) };
    }

    // ── Excel ──
    if (name.endsWith('.xlsx') || mt.includes('spreadsheetml')) {
      const { xlsxToText } = require('./xlsx');
      return { text: await xlsxToText(buffer, maxChars) };
    }
    if (name.endsWith('.xls')) {
      return { note: `${filename}: פורמט .xls ישן לא נתמך — שמור כ-.xlsx או העלה ל-Drive.` };
    }

    // ── Word ──
    if (name.endsWith('.docx') || mt.includes('wordprocessingml')) {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer });
      const text = (value || '').trim();
      return text ? { text: text.slice(0, maxChars) } : { note: `${filename}: מסמך ריק.` };
    }
    if (name.endsWith('.doc')) {
      return { note: `${filename}: פורמט .doc ישן לא נתמך — שמור כ-.docx.` };
    }

    // ── Images (email attachments only — uploads go to vision in index.js) ──
    if (mt.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i.test(name)) {
      return { note: `${filename}: תמונה. כדי שאראה אותה — העלה אותה ישירות ל-Discord (לא כקובץ מצורף במייל).` };
    }

    // ── Text / code / data ──
    if (mt.startsWith('text/') || mt.includes('json') || mt.includes('xml') || mt.includes('javascript') || TEXT_RE.test(name)) {
      return { text: buffer.toString('utf-8').slice(0, maxChars) };
    }

    return { note: `${filename}: סוג קובץ לא נתמך. נתמכים: PDF, Word (.docx), Excel (.xlsx), טקסט/CSV/קוד, ותמונות (העלאה ישירה).` };
  } catch (err) {
    return { error: `קראתי את הקובץ אבל נכשלתי בפענוח (${filename}): ${err.message}` };
  }
}

module.exports = { parseFileToText };
