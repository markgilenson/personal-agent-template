/**
 * Shared Google OAuth2 client factory.
 * Used by the gmail, calendar, and drive tools.
 */

const { google } = require('googleapis');
const mem = require('./memory');

function getAuth() {
  const refreshToken = mem.recall('google_refresh_token') || process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('Google not connected — visit /auth on the agent to authorize.');
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

module.exports = { getAuth };
