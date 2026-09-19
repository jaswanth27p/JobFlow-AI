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
  // Free text. Fed to the per-job relevance judge (the LinkedIn search agent
  // trusts its own search filters and does not judge).
  requirements: `
    Look for backend / full-stack engineering roles.
    Prefer remote or hybrid.
    Avoid roles requiring more than 8 years of experience.
  `,
  concurrency: 1,
  // No-op — kept only so this file's shape still matches AppConfig. The
  // single-tab sequential pipeline always scrapes, judges, and applies
  // exactly one job at a time; see judge-worker.ts.
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
    // cap on jobs scanned per run — a search URL stops being paginated once
    // it runs out of results/pages.
    minNavDelayMs: 3000,
    maxNavDelayMs: 8000,
  },
} satisfies AppConfig;
