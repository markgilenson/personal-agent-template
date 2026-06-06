const path = require('path');
const fs   = require('fs');
const mem  = require('../memory');

const DB_PATH  = process.env.DB_PATH || path.join(__dirname, '..', '..', 'mark-agent.db');
const AUTH_DIR = path.join(path.dirname(DB_PATH), 'baileys_auth');

// Suppress Baileys' verbose pino logger without requiring the pino package.
const silentLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
  error: () => {}, fatal: () => {},
  child() { return silentLogger; },
};

let sock         = null;
let _onQR        = null;
let _connected   = false;

/**
 * Connect to WhatsApp.
 * @param {function} onQR - called with the QR string when a scan is needed
 */
async function connect(onQR) {
  _onQR = onQR;
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Baileys is ESM-only — use dynamic import from our CJS project.
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
  } = await import('@whiskeysockets/baileys');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: silentLogger,
    printQRInTerminal: false,
    // Needed to decrypt some message types
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && _onQR) {
      console.log('[whatsapp] QR ready — sending to Discord');
      _onQR(qr).catch(e => console.error('[whatsapp] QR send failed:', e.message));
    }

    if (connection === 'open') {
      _connected = true;
      console.log(`[whatsapp] Connected as ${sock.user?.name || sock.user?.id}`);
    }

    if (connection === 'close') {
      _connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[whatsapp] Closed (code ${code})`);
      if (loggedOut) {
        // Clear saved credentials so next /wa-connect starts fresh
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log('[whatsapp] Logged out — auth cleared. Use /wa-connect to reconnect.');
      } else {
        // Network error / restart — reconnect automatically
        setTimeout(() => connect(_onQR), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // skip messages Mark sent
      const text = extractText(msg);
      if (!text) continue;

      const jid      = msg.key.remoteJid || '';
      const isGroup  = jid.endsWith('@g.us');
      const sender   = msg.pushName ||
        (isGroup ? msg.key.participant : jid).replace('@s.whatsapp.net', '');

      // Resolve group name asynchronously — don't block message storage
      let groupName = null;
      if (isGroup && sock) {
        try {
          const meta = await sock.groupMetadata(jid);
          groupName = meta.subject || null;
        } catch {}
      }

      mem.storeWhatsAppMessage(jid, sender, text, isGroup ? 1 : 0, groupName);
    }
  });
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    null
  );
}

function getStatus() {
  if (!sock) return 'not initialized';
  if (_connected && sock.user) return `connected as ${sock.user.name || sock.user.id}`;
  return 'connecting / disconnected';
}

module.exports = { connect, getStatus };
