import type { AppConfig } from './src/config/schema.ts'

export default {
  // Named groups of search-results URLs. /search-urls and /auto-on open a
  // picker to choose one group or "All groups". Each URL's own filters
  // (keywords, location, date posted) are trusted as the relevance signal —
  // the search agent doesn't re-judge relevance against requirements below,
  // it only dedupes and routes. scanFullList: true bypasses the
  // relevance-ratio pagination gate and scans every page of that URL.
  urlGroups: [
    {
      name: "Hyderabad",
      urls: [
        { url: "https://www.linkedin.com/jobs/search-results/?keywords=software%20engineer&f_TPR=r86400", scanFullList: false },
      ],
    },
  ],
  // Free text. Used ONLY by the career-page scan agent (/add-career-url +
  // /check-careers) to judge relevance — an arbitrary careers page has no
  // equivalent of LinkedIn's own search filters.
  requirements: `
    Look for backend / full-stack engineering roles.
    Prefer remote or hybrid.
    Avoid roles requiring more than 8 years of experience.
  `,
  concurrency: 1,
  // Parallel LLM relevance-judge calls — no browser involved, so this is
  // just concurrent judgeJob() calls (cheap). The browser stage that fetches
  // job content ahead of this always runs serially (1 browser, no knob) to
  // avoid tripping LinkedIn's rate limiting. 1-10, default 10. Live-tunable
  // via /set judgeConcurrency.
  judgeConcurrency: 10,
  profileFiles: {
    resume: "./resume.md",
    profile: "./profile.json",
  },
  // Extra rules appended to the end of the search / easy-apply agent's
  // prompt (see src/prompts/) — add one-off instructions here instead of
  // editing the prompt files themselves. Leave empty strings if you don't
  // need either.
  extraPrompts: {
    search: "",
    easyApply: "",
  },
  model: "opencode-go/deepseek-v4-flash",
  // Per-agent overrides — unset falls back to `model` above. e.g.:
  //   models: { easyApply: "opencode-go/deepseek-v4-pro" },
  models: {},
  autoFocusTabs: false,
  // How often (minutes) to batch external-job-found / easy-apply-result
  // counts into one desktop notification.
  notifySummaryIntervalMinutes: 30,
  search: {
    // LinkedIn rate-limit guard: min/maxNavDelayMs bracket the randomized
    // human-like pause inserted after each browser navigation. There is no
    // cap on jobs scanned per run — a search URL stops being paginated via
    // check-page-relevance-ratio (falling result quality) or simply running
    // out of results/pages.
    minNavDelayMs: 3000,
    maxNavDelayMs: 8000,
    // Minimum pause between full /auto-on loop cycles (re-scanning the same
    // configured URLs) — keeps back-to-back loop iterations from looking
    // like a burst to LinkedIn.
    loopCooldownMs: 300000,
  },
} satisfies AppConfig;
