# Mark's setup — do this once, then per colleague

The goal: each colleague builds and runs their own agent via the guided `ONBOARDING.md`.
They use their **own** Discord bot and authorize their **own** Google account. Hosting lives
in **your** Railway account but in a separate, token-scoped project per person (so they can
only touch their own). You provide a few shared values and one set-once Google app, and you
never edit or maintain their bots.

## One-time (≈20 min, once for everyone)

1. **Google Cloud OAuth app** (the big friction-remover — colleagues reuse this, never touch Cloud Console):
   - In your Google Cloud project: enable **Gmail, Calendar, Drive, Docs, Sheets** APIs.
   - APIs & Services → **Credentials** → create an **OAuth 2.0 Client ID** (type: Web application).
   - Authorized redirect URIs: you'll add each colleague's Railway callback (`https://<their-domain>/auth/callback`) — or use a wildcard-friendly flow. Simplest: add each colleague's domain when they reach Phase 5.
   - OAuth consent screen → **Test users** → add each colleague's Google address (Gmail/Drive are "sensitive," so test-user status lets them authorize without full app verification; ~100 user cap).
   - Copy the **Client ID** and **Client Secret** — these are the shared values you hand out.

2. **Anthropic Console org** (proper shared billing, no key-sharing):
   - console.anthropic.com → Settings → **Members** → invite each colleague.
   - They each create their *own* API key under the org → org billing. (If the Teams-org redirect blocks you, fallback: hand out one key value.)

3. **Groq key** — generate one at console.groq.com; hand it out (shared, low volume).

4. **The repo** — give colleagues access (clone link), or make a clean **template repo** (strip your `src/jmc-context.md` personal data first). The onboarding rewrites the context anyway, but a clean template avoids exposing JMC internals.

## Per colleague (≈5 min of your time)

Their agent is hosted in **your** Railway account, but in a separate project locked to a **scoped project token** — so their Claude Code can only touch that one project, never MishkenBot, your agent, or anyone else's.

1. **Create their Railway project** (in your account):
   - New project → name it (e.g. `agent-dana`).
   - Add a **volume** mounted at `/data`.
   - Generate a **public domain** (note it down).
   - Project Settings → **Tokens** → create a **project token** (scoped to this project + production).
2. **Add their Railway domain's `/auth/callback`** to the shared Google OAuth app's redirect URIs.
3. **Hand them:**
   - The **repo link** ("Use this template" → their own copy, or a direct clone).
   - Their **`RAILWAY_TOKEN`** + their **Railway domain**.
   - The **`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`** values.
   - The **`GROQ_API_KEY`** (and `ANTHROPIC_API_KEY` if not using Console-org keys).
   - Confirmation they're a **Google test user** + **Anthropic org member**.
   - The **`ONBOARDING.md`** (it's in the repo they clone).

That's it — their Claude Code does the rest: customizes the context, creates their own Discord bot, sets variables, deploys to the project you made, and verifies. Anything they want to change later, they do in their own Claude Code session against their own project token.

## Isolation & what you ARE / are NOT on the hook for
- **Isolated:** each project token unlocks one project only; runtime is separate (one bot crashing never affects MishkenBot or the others). They never see your other projects.
- **You ARE on the hook for:** the Railway *account* bill (all projects), the shared Anthropic/Groq spend, and account-level events (a billing failure or suspension takes everything down together).
- **You are NOT on the hook for:** their Discord bot (they own it), their Google data (their token lives only in their project's volume), or fixing their customizations (their Claude Code handles that).
- **Keep yourself safe:** only ever give them a *project token* + the template repo (read-only) + the shared key values. Never add them to your `mark-agent` repo or as members of your Railway account.
