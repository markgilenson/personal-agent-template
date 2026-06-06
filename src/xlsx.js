/**
 * Parse an .xlsx buffer into readable text — one block per sheet,
 * rows rendered as tab-separated values.
 */

const ExcelJS = require('exceljs');

async function xlsxToText(buffer, maxChars = 12000) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const blocks = [];
  wb.eachSheet(sheet => {
    const rows = [];
    sheet.eachRow(row => {
      // row.values is 1-indexed (index 0 is empty); drop it and stringify cells
      const cells = row.values.slice(1).map(cellToText);
      rows.push(cells.join('\t'));
    });
    blocks.push(`## ${sheet.name}\n${rows.join('\n')}`);
  });

  return blocks.join('\n\n').slice(0, maxChars);
}

function cellToText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text);            // rich text / hyperlink
    if (v.result != null) return String(v.result); // formula result
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return JSON.stringify(v);
  }
  return String(v);
}

module.exports = { xlsxToText };
