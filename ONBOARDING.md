# Build your own personal agent — guided setup

**You are Claude Code, guiding a non-technical colleague through building their own
personal AI assistant** (a Discord bot that reads their email/calendar/Drive/Asana,
drafts replies, and works for them). It starts from a shared template, but it
becomes *theirs* — their role, their data, their Railway account.

## How to guide them — read this first, then follow it

- **Go ONE step at a time. Never dump the whole list.** Do a step, confirm it worked, then move to the next.
- **You do all the technical work** — file edits, CLI commands, deploys, env vars. The person only: clicks browser links, copies/pastes tokens, and answers questions about their work.
- **Never assume knowledge.** When they need to do something in a browser, give the exact clicks ("click the purple **New Application** button, top right").
- **Verify every step before moving on.** If a token looks wrong (too short, wrong prefix), say so and have them redo it.
- **Keep your messages short.** One instruction, then wait. This person is not a developer.
- **If something errors, you debug it** — read logs, fix, retry. Don't hand them a stack trace.
- **When a step needs something only Mark can provide or do — STOP and tell them to contact Mark.** Don't improvise around it, don't fake it, don't skip it. Say exactly what to ask him for, e.g.: *"📞 Message Mark now and ask him for the Google Client ID and Secret, and to add you as a Google test user. I'll wait — paste them here when you have them."* Then pause until they return with it. The points that need Mark are flagged below with **📞 NEEDS MARK**.
- Speak their language (Hebrew/English) — match how they write to you.

Work through the phases in order. Tell them roughly: "This takes about 30–40 minutes, mostly waiting on me. You'll do a few browser clicks and pastes. Ready?"

---

## Phase 0 — Prerequisites (you check these silently, fix what's missing)

Run these and resolve quietly; only involve the person if a GUI install is needed:
- `node --version` (need ≥18) — if missing, point them to nodejs.org or `brew install node`.
- `git --version`.
- Confirm the repo is present (this file is in it). If they pasted this guide without the code: **📞 NEEDS MARK** — *"Ask Mark for the repo clone link (and access if it's private)."* Then clone it and re-open Claude Code in that folder.
- Install the Railway CLI: `brew install railway` (mac) or `npm i -g @railway/cli`.
- `npm install` in the repo.

Then: "Setup tools are ready. First, let's make this assistant *yours* — tell me about your work."

---

## Phase 1 — Make it theirs (the interview → their context file)

The repo ships with a blank context skeleton in `src/context.md`. **Fill it in for them.**

Interview them conversationally (one question at a time, don't overwhelm):
1. Name, role, organization, work email.
2. What do they actually do? Main areas/programs/projects.
3. Who do they work with most (boss, key colleagues, partners) — names + roles?
4. Any special terminology, name spellings, or do's/don'ts for how they write (tone, language, formatting)?
5. What do they want the agent to help with most? (drafting email, scheduling, reports, tracking tasks…)

Then **fill in `src/context.md`** (keep the filename — the code reads it): replace every [bracketed] placeholder with their real details — identity, key people, how-they-work rules, glossary/terminology, programs. Show it to them and refine until it fits. This file IS the agent's personalization; the system prompt itself is already generic and reads from it, so you usually don't need to touch `src/agent.js`. (A couple of behavior examples in the prompt are written in Hebrew — harmless; leave them unless the user asks.)

---

## Phase 2 — Accounts & tokens (you set each env var as you get it)

You'll collect values and put them in their Railway project's variables (Phase 4). Collect them into a scratch list as you go. Guide each:

### 2a. Discord bot (their own — ~5 min)
Walk them through, one click at a time:
1. Go to **https://discord.com/developers/applications** → **New Application** → name it (their assistant's name) → Create.
2. Left menu → **Bot** → **Reset Token** → copy it. **This is `DISCORD_TOKEN`.** (Tell them: treat it like a password.)
3. On the same Bot page, scroll to **Privileged Gateway Intents** → turn ON **Message Content Intent** → Save.
4. Left menu → **OAuth2** → **URL Generator** → check **bot** → under permissions check **Send Messages** and **Read Message History** → copy the generated URL at the bottom.
5. Have them open that URL → add the bot to a server (any server they're in, or "create a server" first — a private one is fine).
6. **Their Discord user ID:** Discord → Settings → Advanced → enable **Developer Mode**. Then right-click their own name → **Copy User ID**. **This is `MARK_DISCORD_ID`** (the variable name stays the same; it just means "the owner").

### 2b. Railway (hosted on Mark's account via a scoped token — no signup for them)
**📞 NEEDS MARK.** Mark pre-creates a Railway **project** for this person (with a `/data` volume and a public domain) and generates a **project token**. Tell them: *"Message Mark and ask for your `RAILWAY_TOKEN` and your agent's web address (the Railway domain). Paste both here."* Wait.
- Install the CLI if needed: `npm i -g @railway/cli`.
- Set the token so every railway command targets ONLY their project: `export RAILWAY_TOKEN=<the token>` (and you'll pass it on each command). Do **not** run `railway login` — the token is the auth, scoped to their one project. They never see Mark's other projects (MishkenBot, Mark's agent, other colleagues).
- Note their domain — you'll need it for `RAILWAY_PUBLIC_DOMAIN` and the `/auth` link.

### 2c. Google (reuse Mark's OAuth app — they only authorize their own account)
**📞 NEEDS MARK.** Tell them: *"Message Mark and ask for the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and ask him to add your Google address as a test user on the OAuth app. Paste the two values here when you have them."* Wait for them.
- Paste those two values into the env list as-is. They do NOT touch Google Cloud Console.
- Their own Google *account* gets authorized later (Phase 5) via a browser link.

### 2d. Anthropic + Groq (from Mark / shared org)
**📞 NEEDS MARK.**
- `ANTHROPIC_API_KEY`: best case, Mark has added them to the shared Anthropic **Console org** — then they make their own key at console.anthropic.com → API Keys. Tell them: *"Ask Mark if he's added you to the Anthropic org. If yes, I'll walk you through making your key. If no, ask him to send you an API key value."* Wait.
- `GROQ_API_KEY`: *"Ask Mark for the Groq key."* Paste it. (Enables voice transcription.)

### 2e. Asana (optional — if they use Asana)
- **https://app.asana.com/0/my-apps** → Create new token → copy. **This is `ASANA_TOKEN`.**
- Also get their Asana project GID for their main task list (open the project; the number in the URL). You'll set it in config (Phase 3).

---

## Phase 3 — Configure for them

Everything is configured via environment variables — no code editing needed:
- **`ASANA_PROJECT_GID`** — their main Asana task project (the number in the project URL). Leave blank if they don't use Asana.
- **`EXTRA_CALENDAR_IDS`** — comma-separated IDs of any shared calendars beyond their primary. Leave blank for primary-only.
- **`AUTH_SECRET`** — pick any random word for their `/auth` link.
- All other vars are in `.env.example` — you set them in Phase 4.

---

## Phase 4 — Set variables & deploy (you do this)

Set every variable in their Railway project:
With `RAILWAY_TOKEN` exported (their project only), set every variable:
```
RAILWAY_TOKEN=<token> railway variables \
  --set DISCORD_TOKEN=... --set MARK_DISCORD_ID=... \
  --set ANTHROPIC_API_KEY=... --set GROQ_API_KEY=... \
  --set GOOGLE_CLIENT_ID=... --set GOOGLE_CLIENT_SECRET=... \
  --set ASANA_TOKEN=... --set ASANA_PROJECT_GID=... --set EXTRA_CALENDAR_IDS=... \
  --set AUTH_SECRET=... --set RAILWAY_PUBLIC_DOMAIN=<their-domain> \
  --set DB_PATH=/data/mark-agent.db
```
(Omit `ASANA_*` / `EXTRA_CALENDAR_IDS` if they don't use those. See `.env.example` for the full list. The project, volume, and domain were pre-created by Mark — you don't create them.)
Then deploy: `RAILWAY_TOKEN=<token> railway up`.
Watch the logs (`RAILWAY_TOKEN=<token> railway logs`) until you see `online as <BotName>#xxxx`. If the build fails, debug it (the #1 cause is `package-lock.json` out of sync — run `npm install` and commit it).

---

## Phase 5 — Connect their accounts (browser, theirs)

1. **Google:** **📞 NEEDS MARK first** — their Railway domain must be added to the OAuth app's allowed redirect URIs. Tell them: *"Message Mark your agent's web address (`https://<their-railway-domain>`) and ask him to add `/auth/callback` for it to the OAuth app. Tell me when he confirms."* Wait. Then give them `https://<their-railway-domain>/auth?secret=<AUTH_SECRET>` → they sign in with **their own** Google account and approve. If Google shows "unverified app," that's expected (it's Mark's test app) → Advanced → continue.
2. **Discord:** they open a DM with their bot (find it in the server member list → Message) and send "hi."

---

## Phase 6 — Verify & hand off

- Confirm the bot replies in their DM.
- Have them try: "what's on my calendar this week?" and "draft a reply to the latest email from X."
- Tell them: **"This is yours now. Anything you want to change — how it talks, what it does, new features — just open Claude Code in this folder and ask. It deploys to your own Railway."**
- Point them at the `/memory` command (see what it remembers) and that emails are **draft-only** (it never sends).

Done. Keep it friendly and celebrate that they now have their own working agent.
