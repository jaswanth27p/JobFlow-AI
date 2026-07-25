import { z } from 'zod'

export const appConfigSchema = z.object({
  /** Named groups of LinkedIn search URLs, run/looped via /search-urls or
   * /auto-on (picker lets you choose one group or "All groups"). Each URL
   * carries its own scanFullList flag — see below. */
  urlGroups: z.array(z.object({
    name: z.string().min(1),
    urls: z.array(z.object({
      url: z.url(),
      /** When true, the search agent's check-page-relevance-ratio gate
       * (src/agents/search-agent.ts) is bypassed for this URL — it always
       * keeps paginating instead of stopping once a page's relevance ratio
       * drops too low, so it scans the entire result list. */
      scanFullList: z.boolean().default(false),
    })),
  })).default([]),
  /** Free text describing what to look for — consumed ONLY by the career-page
   * scan agent (src/agents/career-scan-agent.ts). The LinkedIn search agent no
   * longer judges relevance: a configured urlGroups entry is trusted as
   * already-filtered by its own LinkedIn search params. */
  requirements: z.string().min(1),
  concurrency: z.number().positive().default(1),
  /** Default/fallback model — used by any agent kind not given an explicit
   * override in `models` below. Also the value /set model edits live at
   * runtime. */
  model: z.string().default('opencode-go/deepseek-v4-flash'),
  /** Per-agent model overrides. Unset fields fall back to `model` above. */
  models: z.object({
    search: z.string().optional(),
    easyApply: z.string().optional(),
    career: z.string().optional(),
    judge: z.string().optional(),
  }).default({}),
  notifySummaryIntervalMinutes: z.number().int().positive().default(30),
  profileFiles: z.object({
    resume: z.string(),
    profile: z.string(),
  }),
  /** Free-text appended to the end of each agent's built prompt (see
   * src/prompts/) — a place for user-specific rules without editing the
   * prompt files themselves. Empty string means no extra block is added. */
  extraPrompts: z.object({
    search: z.string().default(''),
    easyApply: z.string().default(''),
  }).default({ search: '', easyApply: '' }),
  search: z.object({
    // Rate-limit guard to avoid tripping LinkedIn's automation defenses:
    // min/maxNavDelayMs bracket a randomized human-like pause inserted (in
    // code, not left to the model) after every browser navigation. There is
    // no cap on jobs scanned per run — see check-page-relevance-ratio in
    // search-agent.ts for the per-URL pagination stop condition instead.
    minNavDelayMs: z.number().int().min(0).default(3000),
    maxNavDelayMs: z.number().int().min(0).default(8000),
    /** Minimum pause between full /auto-on loop cycles (re-scanning the same
     * configured URLs). Without this, loop mode reopens the same search
     * results back-to-back nonstop — a real LinkedIn rate-limit/ban risk,
     * unlike /auto-on interval which already waits the full interval. */
    loopCooldownMs: z.number().int().min(60_000).default(300_000),
  }).default({ minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300_000 }),
})

export type AppConfig = z.infer<typeof appConfigSchema>
