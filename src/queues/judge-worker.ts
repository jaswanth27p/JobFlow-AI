import { Worker, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { noopLogger } from '@mastra/core/logger'
import { AgentBrowser } from '@mastra/agent-browser'
import { getRedisConnectionOptions } from './connection.ts'
import { getJudgeQueueCounts } from './judge-queues.ts'
import { enqueueApplyJob } from './apply-queues.ts'
import { getJudgeCdpUrl } from '../browser/judge-session.ts'
import { openOwnTab, closeOwnTab, type OwnedTab } from '../browser/tab-guard.ts'
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
  if (!sharedBrowser || !sharedBrowserCdpUrl) {
    const cdpUrl = await getJudgeCdpUrl()
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
  }
  return { browser: sharedBrowser, cdpUrl: sharedBrowserCdpUrl }
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
async function readJobTextAndJudge(jobId: string, browser: AgentBrowser, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof judgeJob>> | null> {
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
    logger.error({ err, jobId }, 'judge: failed to read job detail pane')
    pushLog(JUDGE_TAB, `Could not load job ${jobId} — will retry on a future scan. (${summarizeError(err)})`)
    return null
  }

  if (!jobText) {
    pushLog(JUDGE_TAB, `Could not read job ${jobId}'s detail pane (empty) — will retry on a future scan.`)
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

/** Judges one queued job: re-checks for a duplicate delivery, opens its
 * detail page directly (no click-through from a list), judges it, records
 * and routes the result. Never throws — every failure path logs and returns
 * so the BullMQ worker always moves on to the next job. An optional signal
 * lets stopJudgeWorker() cancel the in-flight wait/judge call immediately on
 * shutdown instead of waiting out DETAIL_PANE_WAIT_MS/JUDGE_TIMEOUT_MS. */
export async function processJudgeJob(jobId: string, sourceUrl: string, signal?: AbortSignal): Promise<void> {
  const db = getDb()
  const existing = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId))
  if (existing.length > 0) {
    pushLog(JUDGE_TAB, `Job ${jobId} already recorded — skipping (duplicate delivery).`)
    return
  }

  const { browser, cdpUrl } = await getJudgeBrowser()
  const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`

  let ownTab: OwnedTab
  try {
    ownTab = await openOwnTab(browser, cdpUrl, applyUrl, `/jobs/view/${jobId}`)
  } catch (err) {
    logger.error({ err, jobId }, 'judge: failed to open job tab')
    pushLog(JUDGE_TAB, `Could not open job ${jobId} — will retry on a future scan. (${summarizeError(err)})`)
    return
  }

  try {
    const verdict = await readJobTextAndJudge(jobId, browser, signal)
    if (verdict) await recordJudgeVerdict(jobId, sourceUrl, applyUrl, verdict)
  } finally {
    await closeOwnTab(browser, ownTab)
  }
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
