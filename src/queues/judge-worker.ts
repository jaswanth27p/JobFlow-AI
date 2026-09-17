import { Worker, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { noopLogger } from '@mastra/core/logger'
import { AgentBrowser } from '@mastra/agent-browser'
import { getRedisConnectionOptions } from './connection.ts'
import { getJudgeQueueCounts } from './judge-queues.ts'
import { enqueueApplyJob } from './apply-queues.ts'
import { getJudgeCdpUrl, invalidateJudgeCdpUrl } from '../browser/judge-session.ts'
import { openOwnTab, navigateOwnTab, isBrowserConnectionError, isOwnedTabGoneError, type OwnedTab } from '../browser/tab-guard.ts'
import { waitForNetwork } from '../utils/network.ts'
import { getDb } from '../db/index.ts'
import { jobs } from '../db/schema.ts'
import { appState, pushLog, setAgentStatus } from '../state/app-state.ts'
import { recordExternalJobFound } from '../notify/summary-aggregator.ts'
import { judgeJob } from '../agents/job-relevance-judge.ts'
import { getCurrentConfig } from '../config/current.ts'
import { resolveModel } from '../config/resolve-model.ts'
import { summarizeError } from '../utils/error-summary.ts'
import { applyUrlToJobId } from '../utils/apply-url-hash.ts'
import { logger } from '../utils/logger.ts'
import type { TabId } from '../state/types.ts'

const JUDGE_TAB: TabId = 'judge'

/** How long to wait after opening a job's detail-page tab before the first
 * snapshot attempt — there's no LLM driving this navigation to decide when
 * the page is "ready", so a fixed pause stands in for that judgment. Two
 * attempts (pause, snapshot, and if still empty, pause+snapshot again) covers
 * a slow-loading detail pane without an unbounded wait. */
const DETAIL_PANE_WAIT_MS = 2000
const DETAIL_PANE_MAX_ATTEMPTS = 2

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

let sharedBrowser: AgentBrowser | null = null
let sharedBrowserCdpUrl: string | null = null

/** Launches (on first call) or reuses the judge worker's own dedicated
 * browser — see judge-session.ts for why this is a separate Chrome process. */
async function getJudgeBrowser(): Promise<{ browser: AgentBrowser; cdpUrl: string }> {
  // Re-fetching getJudgeCdpUrl() on every call (not just when sharedBrowser
  // was never set) is what lets this layer notice a relaunch — see
  // easy-apply-agent.ts's getEasyApplyBrowser, which this mirrors. Without
  // it, sharedBrowser/sharedBrowserCdpUrl stay pointed at a dead browser's
  // old CDP port forever after a crash/relaunch, so every judge call after
  // the first crash fails with "Failed to connect via CDP" until the whole
  // app is restarted.
  const cdpUrl = await getJudgeCdpUrl()
  if (!sharedBrowser || sharedBrowserCdpUrl !== cdpUrl) {
    sharedBrowser = new AgentBrowser({
      cdpUrl,
      scope: 'shared',
      headless: false,
      // No LLM ever drives this browser — nothing here is exposed as an
      // agent tool, so excludeTools isn't needed the way it is for
      // search/easy-apply's Agent-wrapped browsers. Kept anyway for the same
      // "never let raw ANSI errors reach stdout" reason as the other two.
      excludeTools: ['browser_screenshot', 'browser_tabs'],
    })
    sharedBrowser.__setLogger(noopLogger)
    sharedBrowserCdpUrl = cdpUrl
    // The cached tab belonged to whatever browser process just died — it
    // can't be reused against a brand new Chrome process.
    judgeTab = null
  }
  return { browser: sharedBrowser, cdpUrl: sharedBrowserCdpUrl }
}

/** Drops every cached handle on a browser we just learned is dead — see
 * easy-apply-agent.ts's resetEasyApplyBrowser for the full rationale (same
 * pattern, scoped to the judge browser). `staleCdpUrl` must be the cdpUrl
 * the caller was actually using when it failed. */
function resetJudgeBrowser(staleCdpUrl: string): void {
  invalidateJudgeCdpUrl(staleCdpUrl)
  sharedBrowser = null
  sharedBrowserCdpUrl = null
  judgeTab = null
}

/** The one tab this worker ever has open — reused across every job (navigate
 * in place) instead of opening a new one and closing it per job. See
 * navigateOwnTab's doc comment for why: closeOwnTab is best-effort and a
 * missed close used to leave a stray tab behind forever, one per job. */
let judgeTab: OwnedTab | null = null

async function ensureJudgeTab(browser: AgentBrowser, cdpUrl: string, url: string, matchFragment: string): Promise<OwnedTab> {
  if (judgeTab) {
    try {
      judgeTab = await navigateOwnTab(browser, cdpUrl, judgeTab, url, matchFragment)
      return judgeTab
    } catch (err) {
      // Only a genuinely-gone tab (or dead browser) warrants abandoning it and
      // opening a new one — a plain nav failure (offline, DNS, timeout) means
      // the tab is still there, so reopening would leak it. See
      // isOwnedTabGoneError's doc comment for the full story.
      if (!isBrowserConnectionError(err) && !isOwnedTabGoneError(err)) throw err
      logger.warn({ err }, 'judge: could not reuse existing tab, opening a fresh one')
      judgeTab = null
    }
  }
  judgeTab = await openOwnTab(browser, cdpUrl, url, matchFragment)
  return judgeTab
}

interface AcquiredJudgeTab {
  browser: AgentBrowser
  cdpUrl: string
  tab: OwnedTab
}

/** Fail-proof entry point for the judge tab — see easy-apply-agent.ts's
 * acquireEasyApplyTab for the full rationale. Checks the existing
 * browser/tab is actually usable and, if the underlying browser PROCESS is
 * dead (not just the tab), forces a full relaunch and opens one fresh tab on
 * the new browser before giving up. */
async function acquireJudgeTab(jobId: string, applyUrl: string): Promise<AcquiredJudgeTab> {
  const matchFragment = `/jobs/view/${jobId}`
  let { browser, cdpUrl } = await getJudgeBrowser()
  try {
    const tab = await ensureJudgeTab(browser, cdpUrl, applyUrl, matchFragment)
    return { browser, cdpUrl, tab }
  } catch (err) {
    if (!isBrowserConnectionError(err)) throw err
    logger.warn({ err, jobId }, 'judge: browser connection is dead — forcing relaunch and retrying once')
    resetJudgeBrowser(cdpUrl)
    ;({ browser, cdpUrl } = await getJudgeBrowser())
    const tab = await ensureJudgeTab(browser, cdpUrl, applyUrl, matchFragment)
    return { browser, cdpUrl, tab }
  }
}

/** Persists a judge verdict and routes it — the DB-insert half of what used
 * to be the search agent's judge-and-report-job tool. Exported (and taking a
 * plain verdict rather than a browser) so this routing logic is directly
 * testable against a real test-DB row without a live browser/CDP session,
 * the same way easy-apply-agent.ts exports createReportSubmissionTool for
 * testing its own DB-insert branch in isolation. */
export async function recordJudgeVerdict(
  jobId: string,
  sourceUrl: string,
  applyUrl: string,
  verdict: Awaited<ReturnType<typeof judgeJob>>,
): Promise<void> {
  const db = getDb()
  const status = verdict.verdict === 'skip' ? 'skipped' : verdict.applyType === 'easy' ? 'queued' : 'external_saved'
  // .returning() tells us whether this insert actually happened (vs.
  // conflicting with an existing row) — only route on a real insert, so a
  // job already in the DB never gets queued/notified twice.
  const inserted = await db
    .insert(jobs)
    .values({
      id: jobId,
      title: verdict.title,
      company: verdict.company,
      location: verdict.location,
      applyUrl,
      applyType: verdict.applyType,
      sourceUrl,
      status,
      relevanceReason: verdict.reason,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id })

  if (verdict.verdict === 'skip') {
    pushLog(JUDGE_TAB, `Reviewed "${verdict.title}" at ${verdict.company} (id ${jobId}) — not relevant, skipped. Reason: ${verdict.reason}`)
  } else if (inserted.length > 0) {
    if (verdict.applyType === 'easy') {
      await enqueueApplyJob(jobId)
      pushLog(JUDGE_TAB, `Found "${verdict.title}" at ${verdict.company} (id ${jobId}) — added to the Easy Apply queue.`)
    } else {
      recordExternalJobFound()
      pushLog(JUDGE_TAB, `Found "${verdict.title}" at ${verdict.company} (id ${jobId}) — external apply, saved and notified.`)
    }
  } else {
    pushLog(JUDGE_TAB, `Found "${verdict.title}" at ${verdict.company} (id ${jobId}) — already recorded, not routed again.`)
  }

  // A separate external apply link alongside an Easy Apply job — keyed by its
  // own URL hash (not the LinkedIn job id) since it's a distinct record from
  // the Easy Apply queue entry above.
  if (verdict.verdict !== 'skip' && verdict.applyType === 'easy' && verdict.externalUrl) {
    const externalId = applyUrlToJobId(verdict.externalUrl)
    const externalInserted = await db
      .insert(jobs)
      .values({
        id: externalId,
        title: verdict.title,
        company: verdict.company,
        location: verdict.location,
        applyUrl: verdict.externalUrl,
        applyType: 'external',
        sourceUrl,
        status: 'external_saved',
        relevanceReason: verdict.reason,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id })

    if (externalInserted.length > 0) {
      recordExternalJobFound()
      pushLog(JUDGE_TAB, `"${verdict.title}" at ${verdict.company} also lists an external apply link — saved that too.`)
    }
  }
}

/** Reads the currently-open job detail page and judges it in isolation.
 * Returns null on a transient read failure (empty snapshot, thrown error) —
 * the caller must NOT write a DB row for that case, so the id stays "unseen"
 * and is naturally retried by a future scan cycle instead of being falsely
 * recorded as skipped. A judge-call failure is different: it's a real
 * judgment attempt that failed, so it comes back as a safe 'skip' verdict
 * rather than null — UNLESS the failure was a deliberate shutdown abort
 * (`signal.aborted`), which is transient by definition and must also come
 * back as null, not a permanently-recorded skip. */
async function readJobTextAndJudge(jobId: string, browser: AgentBrowser, cdpUrl: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof judgeJob>> | null> {
  let jobText = ''
  try {
    for (let attempt = 0; attempt < DETAIL_PANE_MAX_ATTEMPTS; attempt++) {
      await sleep(DETAIL_PANE_WAIT_MS, signal)
      if (signal?.aborted) return null
      const snap = await browser.snapshot({ interactiveOnly: false })
      jobText = 'snapshot' in snap && snap.snapshot ? snap.snapshot : ''
      if (jobText) break
    }
  } catch (err) {
    // Browser died after the tab was already open OK (mid-read) — reset now
    // rather than leaving the cache pointed at a dead browser/cdpUrl until
    // the async exit-event race (see judge-session.ts) happens to catch up.
    if (isBrowserConnectionError(err)) resetJudgeBrowser(cdpUrl)
    logger.error({ err, jobId }, 'judge: failed to read job detail pane')
    pushLog(JUDGE_TAB, `Could not load job ${jobId} — will retry. (${summarizeError(err)})`)
    return null
  }

  if (!jobText) {
    pushLog(JUDGE_TAB, `Could not read job ${jobId}'s detail pane (empty) — will retry.`)
    return null
  }

  try {
    return await judgeJob(jobText, resolveModel(getCurrentConfig(), appState.settings.model, 'judge'), signal)
  } catch (err) {
    if (signal?.aborted) return null
    logger.error({ err, jobId }, 'judge: relevance judge failed')
    return {
      title: 'Unknown',
      company: 'Unknown',
      location: null,
      applyType: 'external',
      externalUrl: null,
      verdict: 'skip',
      reason: `Relevance judge failed: ${summarizeError(err)}`,
    }
  }
}

/** Judges one queued job: re-checks for a duplicate delivery, waits out any
 * connectivity outage, opens the detail page directly (no click-through from
 * a list), judges it, records and routes the result. A transient failure
 * (tab wouldn't open, detail pane wouldn't read) throws so BullMQ retries it
 * with backoff (see enqueueJudgeJob) instead of the job silently vanishing on
 * one bad attempt — a genuine judgment failure (page read fine, the judge
 * call itself failed) is NOT transient and still resolves normally as a safe
 * 'skip' verdict, see readJobTextAndJudge. An optional signal lets
 * stopJudgeWorker() cancel the in-flight wait/judge call immediately on
 * shutdown instead of waiting out DETAIL_PANE_WAIT_MS/JUDGE_TIMEOUT_MS or a
 * network-outage pause. */
export async function processJudgeJob(jobId: string, sourceUrl: string, signal?: AbortSignal): Promise<void> {
  const db = getDb()
  const existing = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId))
  if (existing.length > 0) {
    pushLog(JUDGE_TAB, `Job ${jobId} already recorded — skipping (duplicate delivery).`)
    return
  }

  // Blocks here (checking every minute) instead of racing straight into a
  // doomed tab-open — this is what stops a connectivity drop from burning
  // through every queued job one after another. See waitForNetwork's doc
  // comment.
  if ((await waitForNetwork(JUDGE_TAB, signal)) === 'aborted') return

  const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`

  let browser: AgentBrowser
  let cdpUrl: string
  try {
    ;({ browser, cdpUrl } = await acquireJudgeTab(jobId, applyUrl))
  } catch (err) {
    logger.error({ err, jobId }, 'judge: failed to open job tab')
    pushLog(JUDGE_TAB, `Could not open job ${jobId} — will retry. (${summarizeError(err)})`)
    // Throw (rather than swallow) so BullMQ retries this job with backoff —
    // see enqueueJudgeJob's attempts/backoff config. Previously this always
    // resolved quietly, which meant BullMQ marked the job "completed" on the
    // very first failure with zero retry and zero DB trace to recover it by.
    throw err
  }

  if (signal?.aborted) return
  const verdict = await readJobTextAndJudge(jobId, browser, cdpUrl, signal)
  if (signal?.aborted) return
  if (!verdict) {
    // A transient read failure (not a deliberate abort, handled above) —
    // throw so BullMQ retries instead of dropping the job with no way back.
    throw new Error(`judge: could not read job ${jobId}'s detail page`)
  }
  await recordJudgeVerdict(jobId, sourceUrl, applyUrl, verdict)
}

let worker: Worker | null = null

/** Aborts the currently-processing job's in-flight wait/judge call —
 * mirrors search-agent.ts's activeAbort. Without this, stopJudgeWorker()'s
 * worker.close() only stops PICKING UP new jobs; it still waits for whatever
 * job is currently active to run to completion on its own (up to
 * DETAIL_PANE_WAIT_MS*2 + JUDGE_TIMEOUT_MS), which is what made a shutdown
 * request look like it "keeps going" instead of stopping promptly like the
 * search agent's abort-based stop does. */
let currentJobAbort: AbortController | null = null

export function isJudgeWorkerRunning(): boolean {
  return worker !== null
}

export function startJudgeWorker(): void {
  if (worker) return

  worker = new Worker(
    'job-judge',
    async (job: Job<{ jobId: string; sourceUrl: string }>) => {
      const counts = await getJudgeQueueCounts()
      setAgentStatus(JUDGE_TAB, 'running', `queue: ${counts.waiting} left`)
      const abort = new AbortController()
      currentJobAbort = abort
      try {
        await processJudgeJob(job.data.jobId, job.data.sourceUrl, abort.signal)
      } finally {
        if (currentJobAbort === abort) currentJobAbort = null
      }
    },
    // One at a time, same as easy-apply — still one LinkedIn account, still
    // needs to look human between opening job detail pages.
    { connection: getRedisConnectionOptions(), concurrency: 1 },
  )

  worker.on('failed', (_job, err) => {
    pushLog(JUDGE_TAB, `Worker error: ${err.message}`)
  })
  // Required: an EventEmitter with no 'error' listener throws on emit, which
  // would otherwise crash the process on a Redis connection hiccup.
  worker.on('error', (err) => {
    pushLog(JUDGE_TAB, `Worker connection error: ${err.message}`)
  })

  pushLog(JUDGE_TAB, 'Judge queue worker started.')
  setAgentStatus(JUDGE_TAB, 'running', 'waiting for jobs')
}

export async function stopJudgeWorker(): Promise<void> {
  if (!worker) return
  // Cancel whatever job is currently in flight FIRST — worker.close() below
  // only stops the worker from picking up the NEXT job; without this it
  // would still let the current one run to completion on its own timeouts.
  currentJobAbort?.abort()
  await worker.close()
  worker = null
  pushLog(JUDGE_TAB, 'Judge queue worker stopped.')
  setAgentStatus(JUDGE_TAB, 'idle', null)
}
