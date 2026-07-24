# LinkedIn Auto-Apply

A terminal application that searches LinkedIn for jobs matching your resume and requirements, and applies to them for you — one at a time, in a real browser window you can watch, stepping in only when it genuinely needs your input (a form question it can't answer, an email verification code, a login checkpoint).

It does **not** store or ask for your LinkedIn password. You log in by hand, once, in a visible browser window the app opens; from then on it reuses that logged-in session.

## What it does

- **Search** — runs the LinkedIn search-result URLs you configure (`mustCheckUrls`), once or on a loop/interval. Every new job it finds gets recorded and routed: no relevance judgment against your resume/requirements for LinkedIn, since your search URL's own filters (keywords, location, date posted) are trusted as the relevance signal.
- **Easy Apply** — works through LinkedIn's own "Easy Apply" queue, filling out the multi-step form for each job.
- **External jobs — saved, not automated** — a job that hands off to the company's own site is saved to the database with its apply link and you get a desktop notification. There's no automated apply flow for external sites: every company's apply form is different enough that scripted automation there breaks constantly, so this app doesn't attempt it.
- **Career pages — separate, still judged** — company career pages you track with `/add-career-url` are scanned by a second agent that DOES judge relevance against your resume/profile/requirements (since, unlike LinkedIn, an arbitrary careers page has no equivalent of LinkedIn's own search filters). A relevant posting is saved and notified the same way an external LinkedIn job is — never auto-applied.
- **Learns as it goes** — the first time it hits a question it can't answer on its own, it asks you once, then remembers the answer (`profile.json`) so it's never asked again.
- **Never applies blind** — every Easy Apply application goes into a Postgres table with a status and a screenshot, so you have a record of what was actually submitted.

## How it works (short version)

One Bun process runs everything: a terminal UI (four tabs — Search / Easy Apply / External Jobs / Career Pages), a background browser it drives via [Playwright](https://playwright.dev/) over Chrome DevTools Protocol, and three [Mastra](https://mastra.ai/) AI agents (LinkedIn search, career-page scan, easy-apply) that each get their own set of tools (navigate, click, type, plus a handful of app-specific ones) and figure out the actual steps themselves — they're not scripted click-sequences, so they adapt to whatever a given job posting or apply form actually looks like. Job/application records live in Postgres; the queue between "found an Easy Apply job" and "applied to it" is BullMQ/Redis. External jobs (from either agent) skip the queue entirely — they're saved with their apply link and you get a desktop notification instead.

For the full technical design (and where the real implementation differs from the original plan), see [`docs/superpowers/specs/2026-07-14-tui-rebuild-design.md`](docs/superpowers/specs/2026-07-14-tui-rebuild-design.md). For codebase-level orientation, see [`CLAUDE.md`](CLAUDE.md).

## Requirements

- [Bun](https://bun.sh/) >= 1.3 (the app itself runs on Bun)
- [Node.js](https://nodejs.org/) >= 18 (the browser subprocess deliberately runs under plain Node, not Bun — see `CLAUDE.md` for why)
- Google Chrome (stable) installed — the app drives your system Chrome, not a bundled Chromium, so Google sign-in doesn't flag it as insecure
- [Docker](https://www.docker.com/) (for Postgres + Redis — or point at existing instances of both, see below)
- An [OpenCode Zen](https://opencode.ai/docs/zen) API key (`OPENCODE_API_KEY`) — this is what powers every agent's LLM calls. Free/low-cost models are available; see the model notes below.
- A LinkedIn account you're comfortable automating job applications from. **You are responsible for how you use this tool against LinkedIn's Terms of Service** — this project doesn't attempt to hide or disguise its automation.

## Setup

1. **Install dependencies**

   ```bash
   bun install
   ```

   If `bun install` prompts about untrusted postinstall scripts, run:

   ```bash
   bun pm untrusted   # confirm agent-browser / playwright-core are listed
   bun pm trust agent-browser playwright-core
   ```

   This lets Playwright download its bundled Chromium — required for the browser the app drives.

2. **Start Postgres and Redis**

   ```bash
   docker compose up -d
   ```

   This maps Postgres to host port `5433` and Redis to `6380` (not the defaults — deliberately remapped so this doesn't collide with other Postgres/Redis instances you might already be running). If you'd rather point at existing instances instead, skip this step and edit `DATABASE_URL`/`REDIS_URL` in `.env` (step 3).

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Then edit `.env`:

   | Variable | Required | Description |
   |---|---|---|
   | `OPENCODE_API_KEY` | Yes | Your OpenCode Zen API key — every agent's LLM calls fail without this. |
   | `MASTRA_MODEL` | No | Unused by the app directly (the model is set in `linkedin-auto.config.ts` instead) — left here for reference. |
   | `DATABASE_URL` | Yes | Postgres connection string. Defaults to the `docker compose` instance above. |
   | `REDIS_URL` | Yes | Redis connection string. Defaults to the `docker compose` instance above. |

4. **Push the database schema**

   ```bash
   bun run db:push
   ```

5. **Set up your personal config files**

   ```bash
   cp resume.example.md resume.md
   cp profile.example.json profile.json
   cp linkedin-auto.config.example.ts linkedin-auto.config.ts
   ```

   Edit all three with your real information — resume, structured profile facts, and what to search for/skip (see [Configuration](#configuration) below for what each field means). **All three are gitignored** — they hold personal data (and, for the config, your own search URLs/filtering rules) and are never meant to be committed. Only the `*.example.*` versions are tracked in git.

6. **Run it**

   ```bash
   bun run dev
   ```

   A visible Chrome window opens to the LinkedIn login page. Log in by hand. Back in the terminal, run `/verify-login` — once it confirms you're logged in, every command unlocks.

## Configuration

### `linkedin-auto.config.ts`

Copied from `linkedin-auto.config.example.ts` (step 5 above) — this is your personal, gitignored copy.

```ts
export default {
  mustCheckUrls: [                    // LinkedIn search-results URLs to run with /search-urls or /auto-on.
    'https://www.linkedin.com/jobs/search/?f_TPR=r86400&keywords=software%20engineer',
  ],
  requirements: `                     // Free text — used ONLY by the career-page scan agent
    Look for senior backend / full-stack engineering roles.  // (/add-career-url + /check-careers). LinkedIn search
    Prefer remote or hybrid in the US.                        // no longer judges relevance — mustCheckUrls' own
    Avoid roles requiring more than 8 years of experience.    // LinkedIn filters are trusted for that.
  `,
  concurrency: 1,                     // Reserved for future use; queue workers currently always run at concurrency 1.
  profileFiles: {
    resume: './resume.md',
    profile: './profile.json',
  },
  extraPrompts: {                     // Free text appended to the end of the built prompt for each
    search: '',                       // agent (src/prompts/) — one-off rules ("skip company X") without
    easyApply: '',                    // editing the prompt files themselves. '' means nothing added.
  },
  model: 'opencode-go/deepseek-v4-flash',  // 'provider/model' — see Model notes below.
  notifySummaryIntervalMinutes: 30,   // Batches external-job-found / easy-apply-result counts into one
                                       // desktop notification every N minutes, instead of one per event.
  search: {
    minNavDelayMs: 3000,              // Randomized human-like pause after each browser navigation…
    maxNavDelayMs: 8000,              // …between these two bounds (LinkedIn rate-limit guard).
    loopCooldownMs: 300000,           // Minimum pause between full /auto-on loop cycles.
  },
}
```

There is no cap on jobs scanned per run — a search URL stops being paginated when its result relevance ratio drops too low or it runs out of pages, not after a fixed count.

`model` and every `search.*` number can also be changed at runtime without restarting, via `/set model <name>`, `/set minNavDelayMs <ms>`, etc.

### `profile.json`

Structured facts the agents use to fill forms directly, without needing to ask you or infer from your resume:

```json
{
  "contact": { "email": "you@example.com", "phone": "", "location": "" },
  "workAuth": { "authorized": true, "requiresSponsorship": false },
  "experienceYears": 5,
  "salaryExpectation": { "min": 0, "max": 0, "currency": "USD" },
  "links": { "linkedin": "", "github": "", "portfolio": "" },
  "answers": {}
}
```

`answers` starts empty and fills in on its own — every time an agent asks you a question it can't otherwise answer, your reply gets saved here (keyed by the question text) so it's never asked again. You can also hand-edit this file directly if you want to pre-fill or correct an answer.

### `resume.md`

Free text — your resume, in Markdown or plain text. Used as LLM context for relevance judging and for answering free-text application questions ("why are you a good fit for this role", etc.). Not parsed into structured fields, so formatting doesn't matter much; content does.

### Model notes

`model` is a `'provider/model'` string resolved by Mastra's model router against your `OPENCODE_API_KEY`. This project defaults every agent to **`opencode-go/deepseek-v4-flash`** — fast, cheap, and sufficient since none of the agents need image/vision understanding (they read pages as structured accessibility snapshots, not screenshots). If you need a vision-capable model for some reason, `opencode-go/mimo-v2.5` is available from the same provider.

## Usage

Once `/verify-login` succeeds, every command below is available. Commands are scoped to a tab — `Tab`/`Shift+Tab` cycles between Search / Easy Apply / External Jobs / Career Pages, or jump directly with `/tab <name>`.

| Command | Tab | What it does |
|---|---|---|
| `/verify-login` | global | Check LinkedIn/Gmail login status; unlocks the app once LinkedIn passes |
| `/tab [search\|easy\|external\|careers]` | global | Switch the active tab (no arg opens a picker) |
| `/theme [name]` | global | Switch color theme (no arg opens a picker) |
| `/set <setting> <value>` | global | Change a runtime setting (`concurrency`, `model`, `minNavDelayMs`, `maxNavDelayMs`, `loopCooldownMs`) without restarting |
| `/help` | global | List commands available on the current tab |
| `/exit` | global | Close the browser and quit (`Ctrl+Q` also works) |
| `/search-urls` | search | Run the URLs from `linkedin-auto.config.ts`'s `mustCheckUrls` |
| `/stop-search` | search | Stop an in-progress search run |
| `/auto-on loop` / `/auto-on interval <1h30m>` | search | Repeatedly run `mustCheckUrls` and keep the Easy Apply worker started |
| `/auto-off` | search | Stop the auto-mode loop/interval |
| `/process-easy-queue` | easy | Start working through queued Easy Apply jobs |
| `/stop-easy-queue` | easy | Stop the Easy Apply worker |
| `/add-career-url <url> [label]` | careers | Track an external company careers page |
| `/check-careers` | careers | Re-scan every tracked career page for new relevant postings (still resume/requirements-judged) |
| `/stop-careers` | careers | Stop an in-progress career-page check |

**External jobs (from LinkedIn or a career page)** are never auto-applied — they're saved to the database with their apply link, and you get a desktop notification (title, company, and the link). Check them anytime at `http://127.0.0.1:4870/external-jobs`, or in the External Jobs tab in the TUI.

A small review dashboard also runs at `http://127.0.0.1:4870` (loopback only; port via `DASHBOARD_PORT`) — today's stats, Easy Apply application history, external jobs found, and a review page where you can mark recorded answers correct/wrong (corrections feed back into `profile.json`).

**When an agent needs your input** — an application question it can't answer, an email verification code, a stuck checkpoint — the input box automatically switches from command mode to plain-text answer mode (the sidebar highlights which tab is waiting, and shows the question). Just type your answer and press Enter; the agent resumes with it.

**Ctrl+Q** exits the app. **Ctrl+C is intentionally left alone** so your terminal's own copy-selected-text shortcut keeps working.

## Data and privacy

- Your LinkedIn password is never read, stored, or requested by this app. Login happens by hand, in a real, visible browser window.
- `resume.md` and `profile.json` are sent to the configured LLM provider (OpenCode Zen) as context for every agent call — review OpenCode's data handling policy if that matters for your use case.
- `resume.md`, `profile.json`, `linkedin-auto.config.ts`, and everything under `data/` (logs, browser session state, application screenshots) are gitignored and stay local to your machine.
- Application screenshots are saved to `data/screenshots/` as proof of what was actually submitted.

## Development

- `bun run typecheck` — TypeScript, no emit.
- `bun test` — full test suite (Bun's native test runner; requires Postgres/Redis running per Setup step 2).
- `bun test tests/unit/commands/dispatch.test.ts` — run a single test file.
- `bun test -t "some test name"` — filter by test name.

There's no automated end-to-end test against real LinkedIn or real job sites — by design (ToS risk, fragility of testing against someone else's live UI). Unit and DB-integration tests cover the logic; running the app for real against your own LinkedIn account is the acceptance check.

