/**
 * One-time script — run locally to generate a Google refresh token.
 * The token goes into Railway env vars. You never need to run this again
 * unless you revoke access in your Google account.
 *
 * Before running:
 *   1. In Google Cloud Console → your OAuth app → Credentials → OAuth 2.0 Client ID
 *      → add  http://localhost:3000/callback  to Authorised Redirect URIs
 *   2. Copy GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET into .env
 *   3. npm install  (if not done yet)
 *   4. node get_google_token.js
 *   5. Copy the printed GOOGLE_REFRESH_TOKEN into Railway env vars
 */

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT = 'http://localhost:3000/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.\n');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',   // read + draft + send gmail
  'https://www.googleapis.com/auth/calendar',        // read + write calendar
  'https://www.googleapis.com/auth/drive.readonly',  // read drive files
  'https://www.googleapis.com/auth/documents',       // read + write google docs
];

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const authUrl = auth.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

// Start a temporary local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== '/callback') { res.end(); return; }

  res.end('<h2>✅ Authenticated — you can close this tab.</h2>');
  server.close();

  const { tokens } = await auth.getToken(query.code);

  console.log('\n────────────────────────────────────────────────────');
  console.log('✅  Success! Add this to Railway environment variables:');
  console.log('────────────────────────────────────────────────────\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\n────────────────────────────────────────────────────');
  console.log('Then delete get_google_token.js — you only need it once.\n');
});

server.listen(3000, () => {
  console.log('\n── Google OAuth Setup ──────────────────────────────');
  console.log('\nStep 1: Make sure http://localhost:3000/callback is listed');
  console.log('        as an Authorised Redirect URI in Google Cloud Console.');
  console.log('\nStep 2: Open this URL in your browser:\n');
  console.log('  ' + authUrl);
  console.log('\nStep 3: Sign in as markgilenson@jmc.org.il and approve.');
  console.log('        The refresh token will appear here automatically.\n');
});
