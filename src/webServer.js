/**
 * Minimal web server — handles Google OAuth callback only.
 * Visit /auth to kick off the flow, /auth/callback catches the token.
 */

const express = require('express');
const { google } = require('googleapis');
const mem = require('./memory');

// Narrowed scopes — read all of Drive, but can only create/modify files the
// agent itself made (drive.file). It physically cannot delete or alter Mark's
// existing Drive files. No send scope is exercised (drafts only).
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',     // read inbox + create drafts (no send)
  'https://www.googleapis.com/auth/calendar',         // read + create events
  'https://www.googleapis.com/auth/drive.readonly',   // read ALL Drive files — cannot modify/delete
  'https://www.googleapis.com/auth/drive.file',        // create/manage ONLY files the agent creates
  'https://www.googleapis.com/auth/documents',         // read/write Google Doc content
  'https://www.googleapis.com/auth/spreadsheets',      // read/write Google Sheet content
];

function getOAuthClient(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

function startWebServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Derive the public base URL from Railway env, or fall back to localhost
  const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

  const REDIRECT_URI = `${BASE_URL}/auth/callback`;

  // ── GET /auth — start OAuth flow ──────────────────────────────────────────
  app.get('/auth', (req, res) => {
    // Simple secret check so only Mark can trigger this
    const secret = process.env.AUTH_SECRET || 'jmc';
    if (req.query.secret !== secret) {
      return res.status(403).send('<h2>403 — add ?secret=YOUR_SECRET to the URL</h2>');
    }

    const auth = getOAuthClient(REDIRECT_URI);
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
    res.redirect(url);
  });

  // ── GET /auth/callback — Google redirects here ─────────────────────────────
  app.get('/auth/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
      return res.send(`<h2>❌ OAuth error: ${error}</h2>`);
    }

    try {
      const auth = getOAuthClient(REDIRECT_URI);
      const { tokens } = await auth.getToken(code);

      if (!tokens.refresh_token) {
        return res.send(`
          <h2>⚠️ No refresh token returned</h2>
          <p>Google only sends a refresh token on first authorization.
          Go to <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>,
          remove access for this app, then try <a href="/auth?secret=${process.env.AUTH_SECRET || 'jmc'}">again</a>.</p>
        `);
      }

      // Save to persistent memory
      mem.remember('google_refresh_token', tokens.refresh_token);

      res.send(`
        <h2>✅ Google connected successfully</h2>
        <p>Refresh token saved to persistent storage.</p>
        <hr>
        <p style="font-size:12px;color:#555">Copy this token and send it to Mark Agent in Discord as:<br>
        <code>/settoken google ${tokens.refresh_token}</code></p>
      `);

      console.log('Google refresh token saved to memory.');
    } catch (err) {
      res.send(`<h2>❌ Error: ${err.message}</h2>`);
    }
  });

  // ── GET / — health check ───────────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.send('<h2>mark-agent is running ✅</h2>');
  });

  app.listen(PORT, () => {
    console.log(`Web server on port ${PORT} — auth at ${BASE_URL}/auth?secret=${process.env.AUTH_SECRET || 'jmc'}`);
  });
}

module.exports = { startWebServer };
