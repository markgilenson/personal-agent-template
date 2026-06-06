/**
 * Shared utilities.
 */

// Split text into chunks under Discord's 2000-char message limit, preferring
// to break on newlines but never producing an empty or negative-length slice.
function splitMessage(text, limit = 1900) {
  const chunks = [];
  while (text.length > limit) {
    let cut = text.lastIndexOf('\n', limit);
    if (cut < 800) cut = limit; // no good newline break — hard cut
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}

module.exports = { splitMessage };
