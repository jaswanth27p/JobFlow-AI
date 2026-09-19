import { Worker, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import type { AgentBrowser } from '@mastra/agent-browser'
import { getRedisConnectionOptions } from './connection.ts'
import { enqueueJudgeJob, getJudgeQueueEvents } from './judge-queues.ts'
import { getScrapeQueueCounts } from './scrape-queues.ts'
import { getApplyJobByQueueId, getApplyQueueEvents } from './apply-queues.ts'
import { getPipelineBrowser, ensurePipelineTab } from '../browser/pipeline-tab.ts'
import { waitForNetwork } from '../utils/network.ts'
import { getCurrentConfig } from '../config/current.ts'
import { getDb } from '../db/index.ts'
import { jobContents } from '../db/schema.ts'
import { pushLog, setAgentStatus } from '../state/app-state.ts'
import { summarizeError } from '../utils/error-summary.ts'
import { logger } from '../utils/logger.ts'
import type { TabId } from '../state/types.ts'

const SCRAPE_TAB: TabId = 'scrape'

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

/** Randomized human-like pause between consecutive job page loads — jitter
 * matters, a fixed cadence is itself a bot signal (mirrors search-agent.ts's
 * randomNavDelayMs). Read live off config.search rather than cached at
 * startup, so /reload-config picks up new bounds without a restart. There is
 * no dedicated `scrape` config section — this reuses the same nav-delay
 * bounds the search stage's own browser navigations use, since both are
 * "how long to pause between LinkedIn page loads" and config.search is the
 * only place those bounds are configured. */
function randomScrapeDelayMs(): number {
  const { minNavDelayMs, maxNavDelayMs } = getCurrentConfig().search
  const min = Math.max(0, minNavDelayMs)
  const max = Math.max(min, maxNavDelayMs)
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** Reads the currently-open job detail page. Returns '' on a transient read
 * failure (empty snapshot, thrown error) — the caller must NOT write a
 * job_contents row for that case, so the id stays retryable via BullMQ
 * backoff instead of being falsely marked scraped. */
async function readJobText(jobId: string, browser: AgentBrowser, signal?: AbortSignal): Promise<string> {
  let jobText = ''
  try {
    for (let attempt = 0; attempt < DETAIL_PANE_MAX_ATTEMPTS; attempt++) {
      await sleep(DETAIL_PANE_WAIT_MS, signal)
      if (signal?.aborted) return ''
      const snap = await browser.snapshot({ interactiveOnly: false })
      jobText = 'snapshot' in snap && snap.snapshot ? snap.snapshot : ''
      if (jobText) break
      // An empty snapshot is the failure that silently drops jobs, so record
      // what the page actually was (url/title) rather than just "empty" —
      // otherwise "could not read detail page" is indistinguishable between a
      // login wall, a throttling/rejection page, and a slow-loading pane.
      // Best-effort: must never throw over the original empty-snapshot result.
      let look = ''
      try {
        const ev = await browser.evaluate({
          script: 'JSON.stringify({ url: location.href, title: document.title, ready: document.readyState })',
        })
        look = 'success' in ev && ev.success ? String(ev.result) : JSON.stringify(ev)
      } catch (e) {
        look = `evaluate failed: ${e instanceof Error ? e.message : String(e)}`
      }
      const pageUrl = 'url' in snap ? String((snap as { url?: unknown }).url ?? '') : ''
      const pageTitle = 'title' in snap ? String((snap as { title?: unknown }).title ?? '') : ''
      logger.warn({ jobId, attempt, pageUrl, pageTitle, look }, 'scrape: empty detail-pane snapshot')
      pushLog(
        SCRAPE_TAB,
        `Job ${jobId}: empty snapshot (attempt ${attempt + 1}/${DETAIL_PANE_MAX_ATTEMPTS}) url=${pageUrl || '?'} title=${pageTitle || '?'} ${look}`.slice(0, 300),
      )
    }
  } catch (err) {
    logger.error({ err, jobId }, 'scrape: failed to read job detail pane')
    pushLog(SCRAPE_TAB, `Could not load job ${jobId} — will retry. (${summarizeError(err)})`)
    return ''
  }
  return jobText
}

/** Enqueues the judge job for a scraped id and BLOCKS until it (and, if it
 * turns out to be an easy-apply match, the apply job it triggers) is fully
 * finished — this is what makes the scrape queue's own concurrency:1 refuse
 * to pull the next scrape job until the current one's judge/apply chain has
 * resolved. See docs/superpowers/specs/
 * 2026-09-19-single-tab-sequential-pipeline-design.md's Sequencing section.
 * A judge/apply job that itself ultimately fails (exhausts its own BullMQ
 * retries) is logged and treated as "nothing more to wait for" rather than
 * thrown — that failure is already recorded by that stage; scraping should
 * still move on to the next job. */
async function waitForJudgeAndApply(jobId: string, sourceUrl: string): Promise<void> {
  const judgeJobHandle = await enqueueJudgeJob(jobId, sourceUrl)
  let applyJobId: string | undefined
  try {
    const result = (await judgeJobHandle.waitUntilFinished(getJudgeQueueEvents())) as
      | { triggeredApply?: boolean; applyJobId?: string }
      | undefined
    if (result?.triggeredApply) applyJobId = result.applyJobId
  } catch (err) {
    logger.warn({ err, jobId }, 'scrape: judge job did not finish cleanly — continuing to the next scrape job')
    return
  }

  if (!applyJobId) return

  const applyJobHandle = await getApplyJobByQueueId(applyJobId)
  if (!applyJobHandle) return
  try {
    await applyJobHandle.waitUntilFinished(getApplyQueueEvents())
  } catch (err) {
    logger.warn({ err, jobId }, 'scrape: apply job did not finish cleanly — continuing to the next scrape job')
  }
}

/** Fetches one queued job's detail-page content and hands it off to the judge
 * stage, holding this scrape job open until judge (and any apply it
 * triggers) has fully finished — see waitForJudgeAndApply. Re-checks for a
 * duplicate delivery (job_contents already has this id — the browser step is
 * skipped entirely). A transient failure (tab wouldn't open, detail pane
 * wouldn't read) throws so BullMQ retries with backoff instead of the job
 * silently vanishing on one bad attempt. */
export async function processScrapeJob(jobId: string, sourceUrl: string, signal?: AbortSignal): Promise<void> {
  const db = getDb()
  const existing = await db.select({ jobId: jobContents.jobId }).from(jobContents).where(eq(jobContents.jobId, jobId))
  if (existing.length > 0) {
    await waitForJudgeAndApply(jobId, sourceUrl)
    return
  }

  if ((await waitForNetwork(SCRAPE_TAB, signal)) === 'aborted') return

  const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`
  pushLog(SCRAPE_TAB, `Fetching job ${jobId}…`)
  // Include the live queue depth in the per-job status: this write would
  // otherwise clobber updateCombinedStatus's count line (they race on the
  // same tab), leaving the sidebar showing only the current id with no sense
  // of how much work is left.
  const counts = await getScrapeQueueCounts()
  setAgentStatus(SCRAPE_TAB, 'running', `${counts.waiting} waiting (fetching ${jobId})`)

  const { browser } = getPipelineBrowser()
  try {
    await ensurePipelineTab(applyUrl, `/jobs/view/${jobId}`)
  } catch (err) {
    logger.error({ err, jobId }, 'scrape: failed to open job tab')
    pushLog(SCRAPE_TAB, `Could not open job ${jobId} — will retry. (${summarizeError(err)})`)
    throw err
  }

  if (signal?.aborted) return
  const jobText = await readJobText(jobId, browser, signal)
  if (signal?.aborted) return
  if (!jobText) {
    throw new Error(`scrape: could not read job ${jobId}'s detail page`)
  }

  await db.insert(jobContents).values({ jobId, sourceUrl, content: jobText }).onConflictDoNothing()
  pushLog(SCRAPE_TAB, `Job ${jobId} fetched (${jobText.length} chars) — queued for judging.`)
  await waitForJudgeAndApply(jobId, sourceUrl)
}

let worker: Worker | null = null
let currentJobAbort: AbortController | null = null

export function isScrapeWorkerRunning(): boolean {
  return worker !== null
}

/** Exactly one BullMQ Worker, `concurrency: 1` — hardcoded, no knob. Parallel
 * Chrome navigations on this account are what got LinkedIn to throttle in
 * the first place (see docs/superpowers/specs/2026-09-18-judge-scrape-split-design.md),
 * and this worker's own processor now blocks until judge+apply for the
 * current job are done too (see waitForJudgeAndApply) — concurrency above 1
 * would defeat that gating entirely. */
export function startScrapeWorker(): void {
  if (worker) return

  worker = new Worker(
    'job-scrape',
    async (job: Job<{ jobId: string; sourceUrl: string }>) => {
      const abort = new AbortController()
      currentJobAbort = abort
      try {
        await processScrapeJob(job.data.jobId, job.data.sourceUrl, abort.signal)
      } finally {
        if (currentJobAbort === abort) currentJobAbort = null
        // Politeness pause after every attempt (success or failure) — without
        // it, BullMQ's concurrency:1 worker pulls the next job the instant
        // this one resolves, hammering LinkedIn back-to-back with none of the
        // jitter the search stage already has.
        await sleep(randomScrapeDelayMs(), abort.signal)
      }
    },
    { connection: getRedisConnectionOptions(), concurrency: 1 },
  )

  worker.on('failed', (_job, err) => {
    pushLog(SCRAPE_TAB, `Scrape worker error: ${err.message}`)
  })
  worker.on('error', (err) => {
    pushLog(SCRAPE_TAB, `Scrape worker connection error: ${err.message}`)
  })

  pushLog(SCRAPE_TAB, 'Scrape queue worker started.')
  setAgentStatus(SCRAPE_TAB, 'running', 'starting…')
  void getScrapeQueueCounts()
    .then((c) => setAgentStatus(SCRAPE_TAB, 'running', `idle — ${c.waiting} waiting in queue`))
    .catch(() => setAgentStatus(SCRAPE_TAB, 'running', 'waiting for jobs'))
}

export async function stopScrapeWorker(): Promise<void> {
  if (!worker) return
  currentJobAbort?.abort()
  await worker.close()
  worker = null
  pushLog(SCRAPE_TAB, 'Scrape queue worker stopped.')
}
