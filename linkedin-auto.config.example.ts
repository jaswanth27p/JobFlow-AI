import type { AppConfig } from './src/config/schema.ts'

export default {
  // LinkedIn search-results URLs to run with /search-urls or /auto-on. Each
  // URL's own filters (keywords, location, date posted) are trusted as the
  // relevance signal — the search agent doesn't re-judge relevance against
  // requirements below, it only dedupes and routes.
  mustCheckUrls: [
    "https://www.linkedin.com/jobs/search-results/?keywords=software%20engineer&f_TPR=r86400",
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
