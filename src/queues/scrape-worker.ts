import { Worker, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { noopLogger } from '@mastra/core/logger'
import { AgentBrowser } from '@mastra/agent-browser'
import { getRedisConnectionOptions } from './connection.ts'
import { enqueueJudgeJob } from './judge-queues.ts'
import { getScrapeCdpUrl, invalidateScrapeCdpUrl } from '../browser/scrape-session.ts'
import { openOwnTab, navigateOwnTab, closeStrayTabs, isBrowserConnectionError, isOwnedTabGoneError, type OwnedTab } from '../browser/tab-guard.ts'
import { waitForNetwork } from '../utils/network.ts'
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

let sharedBrowser: AgentBrowser | null = null
let sharedBrowserCdpUrl: string | null = null

/** Launches (on first call) or reuses the scrape worker's own dedicated
 * browser — see scrape-session.ts for why this is a separate Chrome process,
 * and why there is only ever one (no slot/pool model). */
async function getScrapeBrowser(): Promise<{ browser: AgentBrowser; cdpUrl: string }> {
  // Re-fetching getScrapeCdpUrl() on every call (not just when sharedBrowser
  // was never set) is what lets this layer notice a relaunch — see
  // easy-apply-agent.ts's getEasyApplyBrowser, which this mirrors.
  const cdpUrl = await getScrapeCdpUrl()
  if (!sharedBrowser || sharedBrowserCdpUrl !== cdpUrl) {
    sharedBrowser = new AgentBrowser({
      cdpUrl,
      scope: 'shared',
      headless: false,
      excludeTools: ['browser_screenshot', 'browser_tabs'],
    })
    sharedBrowser.__setLogger(noopLogger)
    sharedBrowserCdpUrl = cdpUrl
    scrapeTab = null
  }
  return { browser: sharedBrowser, cdpUrl: sharedBrowserCdpUrl }
}

function resetScrapeBrowser(staleCdpUrl: string): void {
  invalidateScrapeCdpUrl(staleCdpUrl)
  sharedBrowser = null
  sharedBrowserCdpUrl = null
  scrapeTab = null
}

/** The one tab this worker ever has open — reused across every job (navigate
 * in place) instead of opening a new one and closing it per job. */
let scrapeTab: OwnedTab | null = null

async function ensureScrapeTab(browser: AgentBrowser, cdpUrl: string, url: string, matchFragment: string): Promise<OwnedTab> {
  if (scrapeTab) {
    try {
      scrapeTab = await navigateOwnTab(browser, cdpUrl, scrapeTab, url, matchFragment)
      return scrapeTab
    } catch (err) {
      if (!isBrowserConnectionError(err) && !isOwnedTabGoneError(err)) throw err
      logger.warn({ err }, 'scrape: could not reuse existing tab, opening a fresh one')
      scrapeTab = null
    }
  }
  scrapeTab = await openOwnTab(browser, cdpUrl, url, matchFragment)
  // The scrape browser is dedicated to this one job at a time — anything
  // other than the tab we just opened is a stray (an earlier tab a redirect
  // took off its matchFragment, or the initial blank tab).
  await closeStrayTabs(browser, matchFragment)
  return scrapeTab
}

interface AcquiredScrapeTab {
  browser: AgentBrowser
  cdpUrl: string
  tab: OwnedTab
}

async function acquireScrapeTab(jobId: string, applyUrl: string): Promise<AcquiredScrapeTab> {
  const matchFragment = `/jobs/view/${jobId}`
  let { browser, cdpUrl } = await getScrapeBrowser()
  try {
    const tab = await ensureScrapeTab(browser, cdpUrl, applyUrl, matchFragment)
    return { browser, cdpUrl, tab }
  } catch (err) {
    if (!isBrowserConnectionError(err)) throw err
    logger.warn({ err, jobId }, 'scrape: browser connection is dead — forcing relaunch and retrying once')
    resetScrapeBrowser(cdpUrl)
    ;({ browser, cdpUrl } = await getScrapeBrowser())
    const tab = await ensureScrapeTab(browser, cdpUrl, applyUrl, matchFragment)
    return { browser, cdpUrl, tab }
  }
}

/** Reads the currently-open job detail page. Returns '' on a transient read
 * failure (empty snapshot, thrown error) — the caller must NOT write a
 * job_contents row for that case, so the id stays retryable via BullMQ
 * backoff instead of being falsely marked scraped. */
async function readJobText(jobId: string, browser: AgentBrowser, cdpUrl: string, signal?: AbortSignal): Promise<string> {
  let jobText = ''
  try {
    for (let attempt = 0; attempt < DETAIL_PANE_MAX_ATTEMPTS; attempt++) {
      await sleep(DETAIL_PANE_WAIT_MS, signal)
      if (signal?.aborted) return ''
      const snap = await browser.snapshot({ interactiveOnly: false })
      jobText = 'snapshot' in snap && snap.snapshot ? snap.snapshot : ''
      if (jobText) break
      pushLog(SCRAPE_TAB, `Job ${jobId}: detail pane still empty (attempt ${attempt + 1}/${DETAIL_PANE_MAX_ATTEMPTS}) — waiting and retrying.`)
    }
  } catch (err) {
    if (isBrowserConnectionError(err)) resetScrapeBrowser(cdpUrl)
    logger.error({ err, jobId }, 'scrape: failed to read job detail pane')
    pushLog(SCRAPE_TAB, `Could not load job ${jobId} — will retry. (${summarizeError(err)})`)
    return ''
  }
  return jobText
}

/** Fetches one queued job's detail-page content and hands it off to the judge
 * stage: re-checks for a duplicate delivery (job_contents already has this
 * id — the browser step is skipped entirely, only the judge-queue enqueue
 * runs, which is itself an idempotent no-op via BullMQ's jobId dedupe), waits
 * out any connectivity outage, opens the detail page directly, persists the
 * content, and enqueues it for judging. A transient failure (tab wouldn't
 * open, detail pane wouldn't read) throws so BullMQ retries with backoff
 * instead of the job silently vanishing on one bad attempt. */
export async function processScrapeJob(jobId: string, sourceUrl: string, signal?: AbortSignal): Promise<void> {
  const db = getDb()
  const existing = await db.select({ jobId: jobContents.jobId }).from(jobContents).where(eq(jobContents.jobId, jobId))
  if (existing.length > 0) {
    await enqueueJudgeJob(jobId, sourceUrl)
    return
  }

  if ((await waitForNetwork(SCRAPE_TAB, signal)) === 'aborted') return

  const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`
  pushLog(SCRAPE_TAB, `Fetching job ${jobId}…`)
  setAgentStatus(SCRAPE_TAB, 'running', `fetching job ${jobId}`)

  let browser: AgentBrowser
  let cdpUrl: string
  try {
    ;({ browser, cdpUrl } = await acquireScrapeTab(jobId, applyUrl))
  } catch (err) {
    logger.error({ err, jobId }, 'scrape: failed to open job tab')
    pushLog(SCRAPE_TAB, `Could not open job ${jobId} — will retry. (${summarizeError(err)})`)
    throw err
  }

  if (signal?.aborted) return
  const jobText = await readJobText(jobId, browser, cdpUrl, signal)
  if (signal?.aborted) return
  if (!jobText) {
    throw new Error(`scrape: could not read job ${jobId}'s detail page`)
  }

  await db.insert(jobContents).values({ jobId, sourceUrl, content: jobText }).onConflictDoNothing()
  await enqueueJudgeJob(jobId, sourceUrl)
  pushLog(SCRAPE_TAB, `Job ${jobId} fetched (${jobText.length} chars) — queued for judging.`)
}

let worker: Worker | null = null
let currentJobAbort: AbortController | null = null

export function isScrapeWorkerRunning(): boolean {
  return worker !== null
}

/** Exactly one BullMQ Worker, `concurrency: 1` — hardcoded, no knob. See the
 * design doc's Problem section for why this must never be raised: parallel
 * Chrome navigations on this account are what got LinkedIn to throttle in
 * the first place. */
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
  setAgentStatus(SCRAPE_TAB, 'running', 'waiting for jobs')
}

export async function stopScrapeWorker(): Promise<void> {
  if (!worker) return
  currentJobAbort?.abort()
  await worker.close()
  worker = null
  pushLog(SCRAPE_TAB, 'Scrape queue worker stopped.')
}
