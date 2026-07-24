import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { Agent } from '@mastra/core/agent'
import { noopLogger } from '@mastra/core/logger'
import { createTool } from '@mastra/core/tools'
import { AgentBrowser } from '@mastra/agent-browser'
import type { ToolCallChunk, ToolResultChunk } from '@mastra/core/stream'
import { getSharedCdpUrl } from '../browser/session.ts'
import { reclaimOwnTab, type OwnedTab } from '../browser/tab-guard.ts'
import { getDb } from '../db/index.ts'
import { jobs, searchRuns } from '../db/schema.ts'
import { appState, pushLog, setAgentStatus } from '../state/app-state.ts'
import { waitForAnswer } from '../state/prompt-channel.ts'
import { enqueueApplyJob } from '../queues/apply-queues.ts'
import { recordExternalJobFound } from '../notify/summary-aggregator.ts'
import { noOpBrowserContextProcessor } from './no-op-browser-context-processor.ts'
import { logger } from '../utils/logger.ts'
import { isDevLogs } from '../utils/dev-mode.ts'
import { buildScanInstructions } from '../prompts/search-agent.prompt.ts'

const SEARCH_TAB = 'search' as const

/** Minimum fraction of a page's jobs (new + already-seen, combined) that must be
 * judged relevant for the agent to keep paginating this search URL. */
const RELEVANCE_CONTINUE_THRESHOLD = 0.25

/** Browser tools that actually hit LinkedIn over the network — these are the
 * ones we pace to stay under LinkedIn's automation-detection thresholds. Local
 * tools (snapshot/evaluate/screenshot) inspect the already-loaded page and are
 * not throttled. */
const NAVIGATION_TOOLS = new Set(['browser_goto', 'browser_click', 'browser_tabs'])

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Randomized human-like pause length from the live settings bounds. Jitter
 * matters: a fixed cadence is itself a bot signal. */
function randomNavDelayMs(): number {
  const min = Math.max(0, appState.settings.minNavDelayMs)
  const max = Math.max(min, appState.settings.maxNavDelayMs)
  return min + Math.floor(Math.random() * (max - min + 1))
}

let sharedBrowser: AgentBrowser | null = null

function getSearchBrowser(): AgentBrowser {
  if (!sharedBrowser) {
    // Default model (opencode-go/deepseek-v4-flash) is text-only — drop the
    // screenshot tool so the agent never hands it an image it can't read.
    sharedBrowser = new AgentBrowser({
      cdpUrl: getSharedCdpUrl(),
      scope: 'shared',
      headless: false,
      excludeTools: ['browser_screenshot'],
    })
  }
  return sharedBrowser
}

let activeAbort: AbortController | null = null
let activeRunPromise: Promise<SearchRunResult> | null = null

export function isSearchRunning(): boolean {
  return activeAbort !== null
}

export function stopSearch(): void {
  activeAbort?.abort()
}

/** Aborts the in-flight search (if any) and waits for it to actually unwind — used on app shutdown so the search agent doesn't keep calling a browser that's about to be killed. */
export async function stopSearchAndWait(): Promise<void> {
  if (!activeAbort) return
  activeAbort.abort()
  if (activeRunPromise) {
    await activeRunPromise.catch(() => {})
  }
}

interface ScanRunContext {
  signal: AbortSignal
  scanned: number
  queued: number
  externalSaved: number
  skipped: number
  /** Jobs judged (new or already-seen) on the CURRENT page/batch — reset per
   * search URL and per page boundary, see computeRelevanceContinueDecision. */
  pageScanned: number
  pageRelevant: number
  /** The tab this run's current search URL is open in. The easy-apply agent
   * opening its own tab (see tab-guard.ts) can silently steal this agent's
   * "active tab" pointer the same way — logSearchStep reclaims it every step. */
  ownTab: OwnedTab | null
}

function formatToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([key]) => key !== '__mastraMetadata')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/**
 * Logs every tool call/result of an agent step, and — critically — enforces the
 * inter-navigation rate limit. The raw `→ tool` / `← tool` trace is developer
 * noise: it only reaches the TUI log panel when DEV_LOGS is on. The natural-
 * language flow a normal user reads is emitted by the tools themselves, not
 * here. Regardless of DEV_LOGS, the full trace always goes to the on-disk log
 * file so a stalled run is still diagnosable.
 *
 * This is an `onStepFinish` handler; Mastra awaits it, so awaiting a sleep here
 * throttles the whole agent loop in code — it does NOT depend on the model
 * choosing to pace itself. Any step that issued a network-hitting browser
 * navigation earns a randomized human-like pause before the next step runs.
 */
async function logSearchStep(
  event: { toolCalls: ToolCallChunk[]; toolResults: ToolResultChunk[] },
  signal: AbortSignal,
  ctx: ScanRunContext,
  browser: AgentBrowser,
): Promise<void> {
  if (ctx.ownTab) await reclaimOwnTab(browser, getSharedCdpUrl(), ctx.ownTab)

  const devLogs = isDevLogs()
  let navigated = false
  for (const call of event.toolCalls) {
    if (devLogs) pushLog(SEARCH_TAB, `→ ${call.payload.toolName}${formatToolArgs(call.payload.args)}`)
    logger.info({ tool: call.payload.toolName, args: call.payload.args }, 'search: tool call')
    if (NAVIGATION_TOOLS.has(call.payload.toolName)) navigated = true
  }
  for (const result of event.toolResults) {
    const status = result.payload.isError ? 'error' : 'ok'
    if (devLogs) pushLog(SEARCH_TAB, `← ${result.payload.toolName} (${status})`)
    logger.info(
      { tool: result.payload.toolName, isError: result.payload.isError, result: result.payload.result },
      'search: tool result',
    )
  }

  if (navigated && !signal.aborted) {
    const delay = randomNavDelayMs()
    if (delay > 0) {
      if (devLogs) pushLog(SEARCH_TAB, `(pausing ${(delay / 1000).toFixed(1)}s to stay under LinkedIn rate limits)`)
      logger.info({ delayMs: delay }, 'search: rate-limit pause')
      await sleep(delay, signal)
    }
  }
}

/** Hard mid-page stop condition only — abort. Runs regardless of any page's
 * relevance ratio (see computeRelevanceContinueDecision for that separate,
 * page-boundary check). Still accepts an optional maxJobsPerRun cap for
 * testability, but nothing in the app wires one up — there is no job-count
 * limit; check-page-relevance-ratio and running out of results/pages are what
 * actually stop a scan. Pure so it's testable. */
export function computeMidPageContinueDecision(ctx: {
  scanned: number
  aborted: boolean
  /** Optional hard cap on jobs opened per run (LinkedIn rate-limit guard). Omit for no cap. */
  maxJobsPerRun?: number
}): boolean {
  if (ctx.aborted) return false
  if (ctx.maxJobsPerRun !== undefined && ctx.scanned >= ctx.maxJobsPerRun) return false
  return true
}

/** Page-boundary gate: whether to keep paginating this search URL, based on
 * what fraction of the page's jobs (new + already-seen) were relevant. An
 * already-seen job counts via its stored status — see check-already-seen.
 * Pure so it's testable. */
export function computeRelevanceContinueDecision(ctx: {
  pageScanned: number
  pageRelevant: number
  threshold: number
}): boolean {
  if (ctx.pageScanned === 0) return true
  return ctx.pageRelevant / ctx.pageScanned >= ctx.threshold
}

function createCheckAlreadySeenTool(ctx: ScanRunContext) {
  return createTool({
    id: 'check-already-seen',
    description:
      "Check whether a LinkedIn job posting has already been recorded in a previous run. Call this BEFORE reading anything else about a card, using the numeric job id from its URL (the digits after /jobs/view/) or its data-occludable-job-id/data-job-id attribute. If seen is true, skip this card immediately — do not read its detail pane, do not call report-job for it.",
    inputSchema: z.object({ jobId: z.string() }),
    outputSchema: z.object({ seen: z.boolean() }),
    execute: async ({ jobId }) => {
      const db = getDb()
      const rows = await db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(eq(jobs.id, jobId))
      const seen = rows.length > 0
      if (seen) {
        pushLog(SEARCH_TAB, `Skipping a job (id ${jobId}) — already recorded in an earlier run.`)
        ctx.pageScanned++
        // A previously skipped/failed job wasn't worth pursuing then either —
        // doesn't count in this page's favor. Everything else (queued,
        // external_saved, needs_input, applied, discovered) does.
        if (rows[0].status !== 'skipped' && rows[0].status !== 'failed') ctx.pageRelevant++
      }
      return { seen }
    },
  })
}

function createReportJobTool(ctx: ScanRunContext) {
  return createTool({
    id: 'report-job',
    description:
      'Record your relevance verdict for a newly-found job (one check-already-seen did NOT flag as seen) and route it. Call this exactly once per new card. Returns whether to keep scanning (a hard rate-limit/abort check only, never a relevance decision — that\'s check-page-relevance-ratio\'s job).',
    inputSchema: z.object({
      jobId: z.string(),
      title: z.string(),
      company: z.string(),
      location: z.string().optional(),
      sourceUrl: z.string(),
      applyUrl: z.string(),
      applyType: z.enum(['easy', 'external']),
      verdict: z.enum(['relevant', 'skip']),
      reason: z.string(),
    }),
    outputSchema: z.object({ continue: z.boolean() }),
    execute: async (input) => {
      ctx.scanned++
      ctx.pageScanned++

      const db = getDb()
      const status = input.verdict === 'skip' ? 'skipped' : input.applyType === 'easy' ? 'queued' : 'external_saved'
      // .returning() tells us whether this insert actually happened (vs.
      // conflicting with an existing row) — only route on a real insert, so a
      // job already in the DB (e.g. the model skipped check-already-seen)
      // never gets queued/notified twice.
      const inserted = await db
        .insert(jobs)
        .values({
          id: input.jobId,
          title: input.title,
          company: input.company,
          location: input.location ?? null,
          applyUrl: input.applyUrl,
          applyType: input.applyType,
          sourceUrl: input.sourceUrl,
          status,
          relevanceReason: input.reason,
        })
        .onConflictDoNothing()
        .returning({ id: jobs.id })

      if (input.verdict === 'skip') {
        ctx.skipped++
        pushLog(SEARCH_TAB, `Reviewed "${input.title}" at ${input.company} (id ${input.jobId}) — not relevant, skipped. Reason: ${input.reason}`)
      } else {
        ctx.pageRelevant++
        if (inserted.length > 0) {
          if (input.applyType === 'easy') {
            ctx.queued++
            await enqueueApplyJob(input.jobId)
            pushLog(SEARCH_TAB, `Found "${input.title}" at ${input.company} (id ${input.jobId}) — added to the Easy Apply queue.`)
          } else {
            ctx.externalSaved++
            recordExternalJobFound()
            pushLog(SEARCH_TAB, `Found "${input.title}" at ${input.company} (id ${input.jobId}) — external apply, saved and notified.`)
          }
        } else {
          pushLog(SEARCH_TAB, `Found "${input.title}" at ${input.company} (id ${input.jobId}) — already recorded, not routed again.`)
        }
      }

      const shouldContinue = computeMidPageContinueDecision({
        scanned: ctx.scanned,
        aborted: ctx.signal.aborted,
      })
      return { continue: shouldContinue }
    },
  })
}

function createCheckPageRelevanceRatioTool(ctx: ScanRunContext) {
  return createTool({
    id: 'check-page-relevance-ratio',
    description:
      "Call this once you've finished every card on the current page/batch, before loading more results (infinite scroll) or clicking a \"Next\" pagination control. Returns whether this search URL's result quality is still good enough to keep paginating, based on the fraction of this page's jobs (new + already-seen) that were relevant.",
    inputSchema: z.object({}),
    outputSchema: z.object({ continue: z.boolean() }),
    execute: async () => {
      const shouldContinue = computeRelevanceContinueDecision({
        pageScanned: ctx.pageScanned,
        pageRelevant: ctx.pageRelevant,
        threshold: RELEVANCE_CONTINUE_THRESHOLD,
      })
      const pct = ctx.pageScanned === 0 ? 0 : Math.round((ctx.pageRelevant / ctx.pageScanned) * 100)
      if (shouldContinue) {
        pushLog(SEARCH_TAB, `Page relevance: ${ctx.pageRelevant}/${ctx.pageScanned} (${pct}%) — continuing to more results.`)
        ctx.pageScanned = 0
        ctx.pageRelevant = 0
      } else {
        pushLog(
          SEARCH_TAB,
          `Page relevance: ${ctx.pageRelevant}/${ctx.pageScanned} (${pct}%) — below the ${Math.round(RELEVANCE_CONTINUE_THRESHOLD * 100)}% threshold, stopping this search URL.`,
        )
      }
      return { continue: shouldContinue }
    },
  })
}

function createRequestHumanInputTool() {
  return createTool({
    id: 'request-human-input',
    description:
      'Ask the human for help when stuck (LinkedIn checkpoint, CAPTCHA, or anything else you cannot resolve yourself). Waits for their typed reply, then returns it as the answer.',
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
    execute: async ({ question }) => {
      pushLog(SEARCH_TAB, `Needs input: ${question}`)
      const answer = await waitForAnswer(SEARCH_TAB, question)
      setAgentStatus(SEARCH_TAB, 'running')
      pushLog(SEARCH_TAB, `Got answer: ${answer}`)
      return { answer }
    },
  })
}

export interface SearchRunResult {
  scanned: number
  queued: number
  externalSaved: number
  urlsTried: string[]
}

export function runSearchUrls(urls: string[]): Promise<SearchRunResult> {
  const run = runSearchUrlsInner(urls)
  activeRunPromise = run.finally(() => {
    activeRunPromise = null
  })
  return run
}

async function runSearchUrlsInner(urls: string[]): Promise<SearchRunResult> {
  if (isSearchRunning()) throw new Error('A search is already running')
  if (urls.length === 0) {
    pushLog(SEARCH_TAB, 'No search URLs to run.')
    return { scanned: 0, queued: 0, externalSaved: 0, urlsTried: [] }
  }

  const abort = new AbortController()
  activeAbort = abort

  const db = getDb()
  const runId = randomUUID()
  await db.insert(searchRuns).values({ id: runId, urlsTried: [] })

  const ctx: ScanRunContext = {
    signal: abort.signal,
    scanned: 0,
    queued: 0,
    externalSaved: 0,
    skipped: 0,
    pageScanned: 0,
    pageRelevant: 0,
    ownTab: null,
  }

  try {
    const instructions = await buildScanInstructions()
    const browser = getSearchBrowser()
    const agent = new Agent({
      id: 'search-agent',
      name: 'Search Agent',
      instructions,
      model: appState.settings.model,
      browser,
      inputProcessors: [noOpBrowserContextProcessor],
      tools: {
        checkAlreadySeen: createCheckAlreadySeenTool(ctx),
        reportJob: createReportJobTool(ctx),
        checkPageRelevanceRatio: createCheckPageRelevanceRatioTool(ctx),
        requestHumanInput: createRequestHumanInputTool(),
      },
    })
    // Agent defaults to Mastra's ConsoleLogger, which writes raw (ANSI-colored)
    // errors straight to stdout — corrupts the opentui TUI frame on any tool
    // error (e.g. a Playwright navigation timeout). Silence it; failures are
    // already surfaced via pushLog/logger.error at the call sites below.
    agent.__setLogger(noopLogger)

    const triedUrls: string[] = []
    for (const url of urls) {
      if (abort.signal.aborted) break

      // Page-relevance counters are per search URL — a fresh URL starts with a
      // clean slate regardless of how the previous one ended.
      ctx.pageScanned = 0
      ctx.pageRelevant = 0
      // '/jobs/search' distinguishes this URL's results tab from the login
      // tabs (feed/inbox) and from any easy-apply tab (always '/jobs/view/').
      ctx.ownTab = { matchFragment: '/jobs/search' }

      setAgentStatus(SEARCH_TAB, 'running', `scanning ${url}`)
      pushLog(SEARCH_TAB, `Scanning ${url}`)
      triedUrls.push(url)

      try {
        await agent.generate(`Search results URL to scan: ${url}`, {
          abortSignal: abort.signal,
          onStepFinish: (event) => logSearchStep(event, abort.signal, ctx, browser),
          // Mastra's Agent.generate defaults maxSteps to 5 tool-call steps total —
          // nowhere near enough to click through a page of job cards (each card is
          // several steps: snapshot, check-already-seen, report-job, click next).
          // There's no cap on jobs scanned per URL (check-page-relevance-ratio and
          // running out of results/pages are what actually end a URL's scan), so
          // this is sized as a generous, fixed backstop against a genuinely stuck
          // agent — not a per-job budget.
          maxSteps: 4000,
        })
      } catch (err) {
        if (abort.signal.aborted) {
          pushLog(SEARCH_TAB, 'Search aborted mid-step.')
          break
        }
        throw err
      }

      await db
        .update(searchRuns)
        .set({
          urlsTried: triedUrls,
          scannedCount: ctx.scanned,
          relevantCount: ctx.queued + ctx.externalSaved,
          skippedCount: ctx.skipped,
        })
        .where(eq(searchRuns.id, runId))

      // Polite pause between search URLs so back-to-back page loads don't look
      // like a burst to LinkedIn.
      await sleep(randomNavDelayMs(), abort.signal)
    }

    await db.update(searchRuns).set({ finishedAt: new Date() }).where(eq(searchRuns.id, runId))

    const stopped = abort.signal.aborted ? ' (stopped early)' : ''
    const summary =
      ctx.scanned === 0
        ? `Finished searching ${triedUrls.length} page(s)${stopped}. No new jobs found.`
        : `Finished searching ${triedUrls.length} page(s)${stopped}. Found ${ctx.scanned} new job(s): ${ctx.queued} queued for Easy Apply, ${ctx.externalSaved} saved as external.`
    pushLog(SEARCH_TAB, summary)
    logger.info(
      { scanned: ctx.scanned, queued: ctx.queued, externalSaved: ctx.externalSaved, urls: triedUrls.length },
      'search: run finished',
    )
    setAgentStatus(SEARCH_TAB, 'idle', null)

    return { scanned: ctx.scanned, queued: ctx.queued, externalSaved: ctx.externalSaved, urlsTried: triedUrls }
  } finally {
    activeAbort = null
    // Always drop back to idle — without this, a thrown error (surfaced to the
    // user by the command layer) left the sidebar stuck on "running" forever.
    setAgentStatus(SEARCH_TAB, 'idle', null)
  }
}
