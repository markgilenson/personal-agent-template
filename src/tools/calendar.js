const { google } = require('googleapis');
const { getAuth } = require('../google-auth');

// Your user's personal calendar + any shared calendars from EXTRA_CALENDAR_IDS
// (comma-separated calendar IDs in Railway vars). Defaults to primary only.
const CALENDARS = [
  { id: 'primary', label: 'Personal' },
  ...(process.env.EXTRA_CALENDAR_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map((id, i) => ({ id, label: `Shared-${i + 1}` })),
];

async function getEvents({ daysAhead = 14 } = {}) {
  const cal = google.calendar({ version: 'v3', auth: getAuth() });
  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 86400000);

  const fetchOne = async ({ id, label }) => {
    try {
      const res = await cal.events.list({
        calendarId: id,
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 30,
      });
      return (res.data.items || []).map(e => ({
        id: e.id,
        title: e.summary,
        start: e.start.dateTime || e.start.date,
        end: e.end.dateTime || e.end.date,
        location: e.location || null,
        description: e.description || null,
        calendar: label,
      }));
    } catch (err) {
      console.error(`[calendar] Error fetching ${label} (${id}):`, err.message);
      return [];
    }
  };

  const results = await Promise.all(CALENDARS.map(fetchOne));
  // Merge all calendars and sort chronologically
  return results
    .flat()
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

/** Returns a proposed event object — caller shows it to the user for approval before creating. */
function buildEventProposal({ title, start, end, location, description, attendees = [] }) {
  return {
    summary: title,
    start: { dateTime: new Date(start).toISOString(), timeZone: 'Asia/Jerusalem' },
    end: { dateTime: new Date(end).toISOString(), timeZone: 'Asia/Jerusalem' },
    location: location || undefined,
    description: description || undefined,
    attendees: attendees.map(email => ({ email })),
  };
}

/** Only called after explicit approval. */
async function createEvent(eventBody, calendarId = 'primary') {
  const cal = google.calendar({ version: 'v3', auth: getAuth() });
  const res = await cal.events.insert({ calendarId, requestBody: eventBody });
  return { created: true, id: res.data.id, link: res.data.htmlLink };
}

module.exports = { getEvents, buildEventProposal, createEvent };
