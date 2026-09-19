import { z } from 'zod'

export const appConfigSchema = z.object({
  /** Named groups of LinkedIn search URLs, run/looped via /search-urls or
   * /auto-on (picker lets you choose one group or "All groups"). Each URL
   * carries its own scanFullList flag — see below. */
  urlGroups: z.array(z.object({
    name: z.string().min(1),
    urls: z.array(z.object({
      url: z.url(),
      /** Currently a no-op: the search agent (src/agents/search-agent.ts) has
       * no relevance-ratio pagination gate anymore — every URL always scans
       * its entire result list regardless of this flag. Kept on the schema so
       * existing linkedin-auto.config.ts files with this field still parse. */
      scanFullList: z.boolean().default(false),
    })),
  })).default([]),
  /** Free text describing what to look for, fed to the per-job relevance
   * judge (src/prompts/job-relevance-judge.prompt.ts). The LinkedIn search
   * agent itself no longer judges relevance: a configured urlGroups entry is
   * trusted as already-filtered by its own LinkedIn search params. */
  requirements: z.string().min(1),
  concurrency: z.number().positive().default(1),
  /** No-op, kept only so existing linkedin-auto.config.ts files with this
   * field still parse — same treatment as urlGroups[].scanFullList below.
   * The single-tab sequential pipeline design
   * (docs/superpowers/specs/2026-09-19-single-tab-sequential-pipeline-design.md)
   * hardcodes the judge queue to `concurrency: 1` (judge-worker.ts) since only
   * one job is ever in flight through the pipeline at a time. */
  judgeConcurrency: z.number().int().min(1).max(10).default(10),
  /** Default/fallback model — used by any agent kind not given an explicit
   * override in `models` below. Also the value /set model edits live at
   * runtime. */
  model: z.string().default('opencode-go/deepseek-v4-flash'),
  /** Per-agent model overrides. Unset fields fall back to `model` above. */
  models: z.object({
    search: z.string().optional(),
    easyApply: z.string().optional(),
    judge: z.string().optional(),
  }).default({}),
  notifySummaryIntervalMinutes: z.number().int().positive().default(30),
  /** Whether tab-guard.ts raises the automated Chrome window to the OS-visible
   * front on every tab switch/open (see src/browser/tab-focus.ts). Set false
   * to stop it stealing window focus / macOS Space while you work — trades
   * away the fix for Chrome throttling background tabs (can affect Easy Apply
   * modal reliability). */
  autoFocusTabs: z.boolean().default(true),
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
  }).default({ minNavDelayMs: 3000, maxNavDelayMs: 8000 }),
})

export type AppConfig = z.infer<typeof appConfigSchema>
