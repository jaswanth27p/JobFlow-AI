import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { noopLogger } from '@mastra/core/logger'
import { AgentBrowser } from '@mastra/agent-browser'
import type { Page } from 'playwright-core'
import { getSharedCdpUrl } from '../browser/session.ts'
import { openOwnTab, navigateOwnTab, reclaimOwnTab, type OwnedTab } from '../browser/tab-guard.ts'
import { getDb } from '../db/index.ts'
import { jobs, searchRuns } from '../db/schema.ts'
import { appState, pushLog, setAgentStatus } from '../state/app-state.ts'
import { waitForAnswer } from '../state/prompt-channel.ts'
import { enqueueJudgeJob } from '../queues/judge-queues.ts'
import { logger } from '../utils/logger.ts'
import { summarizeError } from '../utils/error-summary.ts'

const SEARCH_TAB = 'search' as const

/** Both attributes LinkedIn has used to carry a job card's numeric id — try
 * the occludable one first, fall back to the plain one. */
const JOB_ID_ATTR_SELECTOR = '[data-occludable-job-id], [data-job-id]'

/** Every page of LinkedIn job search results holds exactly this many cards
 * except a genuine last page, which can be shorter (including possibly the
 * very first/only page, if total results are under this). Drives both the
 * undercount-retry check and the last-page detection below. */
export const FULL_PAGE_SIZE = 25

/** Hard circuit breaker against a genuinely stuck/looping scan (e.g. a bug in
 * the last-page detection that never trips) — 200 pages is 5,000 jobs, far
 * more than any single configured URL should ever legitimately have. Same
 * role maxSteps/MAX_RESUME_ATTEMPTS play elsewhere in this codebase. */
const MAX_PAGES_PER_URL = 200

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
    sharedBrowser = new AgentBrowser({ cdpUrl: getSharedCdpUrl(), scope: 'shared', headless: false })
    // AgentBrowser has its own ConsoleLogger — without this, tool-level errors
    // (e.g. a Playwright navigation timeout) still write raw ANSI text to
    // stdout and corrupt the opentui TUI frame.
    sharedBrowser.__setLogger(noopLogger)
  }
  return sharedBrowser
}

/** The one tab the scan loop ever has open — reused across every configured
 * URL (navigate in place) instead of opening a new one and closing it per
 * URL. See navigateOwnTab's doc comment (tab-guard.ts) for why: closeOwnTab
 * is best-effort and a missed close used to leave a stray tab behind forever,
 * one per URL scanned. */
let searchTab: OwnedTab | null = null

async function ensureSearchTab(browser: AgentBrowser, cdpUrl: string, url: string, matchFragment: string): Promise<OwnedTab> {
  if (searchTab) {
    try {
      searchTab = await navigateOwnTab(browser, cdpUrl, searchTab, url, matchFragment)
      return searchTab
    } catch (err) {
      logger.warn({ err }, 'search: could not reuse existing tab, opening a fresh one')
      searchTab = null
    }
  }
  searchTab = await openOwnTab(browser, cdpUrl, url, matchFragment)
  return searchTab
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

/** One search URL plus its per-URL full-list-scan flag — see runSearchUrls. */
export interface ScanUrlEntry {
  url: string
  /** Currently a no-op: the scan loop always walks every URL to its genuine
   * end (no relevance-ratio early stop exists). Kept on the type/config so
   * entries built from existing linkedin-auto.config.ts files still parse. */
  scanFullList: boolean
}

interface ScanRunContext {
  signal: AbortSignal
  /** Every job id encountered across every page of every URL this run,
   * new + already-seen combined — mirrors searchRuns.scannedCount. */
  totalIdsSeen: number
  /** Subset of totalIdsSeen already recorded in a previous run — mirrors
   * searchRuns.skippedCount (nothing is actually "skipped" by the scan loop
   * itself anymore; this is what it declined to re-queue). */
  alreadySeen: number
  /** New job ids handed off to the judge queue this run — mirrors
   * searchRuns.relevantCount (a proxy: "found and worth judging", not yet an
   * actual relevance verdict, which the judge worker produces later). */
  queuedForJudge: number
}

/** Merges freshly-DOM-queried job ids into a page's running collected order,
 * appending only ids not already known (existing order/position is never
 * disturbed). Pure so it's testable. */
export function mergeChecklistIds(existingOrder: string[], domIds: string[]): string[] {
  const known = new Set(existingOrder)
  const merged = existingOrder.slice()
  for (const id of domIds) {
    if (!known.has(id)) {
      known.add(id)
      merged.push(id)
    }
  }
  return merged
}

/** Whether to stop scrolling within a single loaded page. Two consecutive
 * reads adding no new ids is required either way (avoids a false stop if one
 * scroll step happens to land in a dead zone before a card near the bottom
 * has actually mounted) — combined with EITHER the container genuinely
 * reaching its scroll bottom, OR already having collected a full page's
 * worth of ids. The second alternative matters because atBottom detection
 * can be wrong for a given page's DOM structure (trailing content past the
 * last card, or the scroll-container walk landing on the wrong element) —
 * observed in production as a page that had already found all
 * FULL_PAGE_SIZE ids but never reported atBottom, scrolling uselessly until
 * the MAX_SCROLL_STEPS_PER_PASS safety cap gave up. Once a full page is
 * collected there's nothing left to wait for regardless of what atBottom
 * says. Pure so it's testable. */
export function shouldStopScrolling(atBottom: boolean, consecutiveNoNewReads: number, collectedCount: number): boolean {
  if (consecutiveNoNewReads < 2) return false
  return atBottom || collectedCount >= FULL_PAGE_SIZE
}

/** Whether a page's collected-id count is suspicious enough to warrant a
 * second, finer-grained scroll pass rather than trusting it as final. Every
 * page is exactly FULL_PAGE_SIZE jobs except a genuine last page — an
 * undercount without a hard end-of-results signal (a page that came back
 * completely empty) is treated as a probable scroll skip, not a fact. Pure so
 * it's testable. */
export function shouldRetryPageCollection(collectedCount: number, pageWasCompletelyEmpty: boolean): boolean {
  if (pageWasCompletelyEmpty) return false
  return collectedCount < FULL_PAGE_SIZE
}

/** Detects LinkedIn clamping an out-of-range start= back to its last valid
 * page (silently re-serving the same cards) — true when every id on the
 * current page was already present on the immediately previous page. Pure so
 * it's testable. */
export function isDuplicatePage(currentPageIds: string[], previousPageIds: string[]): boolean {
  if (currentPageIds.length === 0 || previousPageIds.length === 0) return false
  const previous = new Set(previousPageIds)
  return currentPageIds.every((id) => previous.has(id))
}

/** Whether this page is the last one for its search URL: it came back with
 * zero cards, it's a duplicate of the previous page (clamped start=), or (the
 * retry pass in collectPageIds having already run) its count is genuinely
 * under a full page. Pure so it's testable. */
export function isLastPage(currentPageIds: string[], previousPageIds: string[]): boolean {
  if (currentPageIds.length === 0) return true
  if (isDuplicatePage(currentPageIds, previousPageIds)) return true
  return currentPageIds.length < FULL_PAGE_SIZE
}

/** Detects a LinkedIn checkpoint/CAPTCHA/authwall redirect from the tab's own
 * URL — deterministic, no LLM judgment needed to recognize it. Best-effort:
 * this covers the URL patterns LinkedIn is known to redirect to, not every
 * possible unexpected page state. Pure so it's testable. */
export function detectCheckpointUrl(url: string): string | null {
  if (/\/checkpoint\/|\/authwall/i.test(url)) {
    return `LinkedIn is showing a checkpoint/verification page (${url}). Please resolve it in the browser, then answer here once done.`
  }
  return null
}

async function readPageIdsOnce(page: Page): Promise<string[]> {
  return page.evaluate((sel: string) => {
    const seen = new Set<string>()
    const ids: string[] = []
    document.querySelectorAll(sel).forEach((el) => {
      const id = el.getAttribute('data-occludable-job-id') || el.getAttribute('data-job-id')
      if (id && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    })
    return ids
  }, JOB_ID_ATTR_SELECTOR)
}

async function isScrollContainerAtBottom(page: Page): Promise<boolean> {
  return page.evaluate((sel: string) => {
    const cards = document.querySelectorAll(sel)
    const last = cards[cards.length - 1]
    if (!last) return true
    let el: Element | null = last.parentElement
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
    if (!el) return true
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2
  }, JOB_ID_ATTR_SELECTOR)
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate((sel: string) => {
    const cards = document.querySelectorAll(sel)
    const first = cards[0]
    if (!first) return
    let el: Element | null = first.parentElement
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
    if (el) el.scrollTop = 0
    else window.scrollTo(0, 0)
  }, JOB_ID_ATTR_SELECTOR)
}

/** Scrolls the nearest scrollable ancestor of the last known card by a
 * fraction (1/divisor) of its own visible height — small and deliberate, not
 * a blind whole-page jump. A big scroll (or scrolling window instead of the
 * actual list panel) is exactly what causes cards to render and unmount again
 * before ever being read, silently skipping them. */
async function scrollByFraction(page: Page, divisor: number, signal: AbortSignal): Promise<void> {
  await page.evaluate(
    ({ sel, divisor }: { sel: string; divisor: number }) => {
      const cards = document.querySelectorAll(sel)
      const last = cards[cards.length - 1]
      if (!last) return
      let el: Element | null = last.parentElement
      while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
      if (el) el.scrollTop += el.clientHeight / divisor
      else window.scrollBy(0, window.innerHeight / divisor)
    },
    { sel: JOB_ID_ATTR_SELECTOR, divisor },
  )
  await sleep(600, signal)
}

/** Hard circuit breaker on a single scroll-and-collect pass — if the
 * scroll-container detection ever picks the wrong DOM element (isBottom
 * never true because scrollTop/scrollHeight are being read off an element
 * that isn't actually the one scrolling), the while loop below has no other
 * way to end: no error, no thrown exception, it would just sleep 600ms/step
 * forever with nothing logged. A page's ~25 cards need well under 20 half-
 * height steps in practice; 60 is a generous ceiling, not a per-job budget. */
const MAX_SCROLL_STEPS_PER_PASS = 60

/** One full top-to-bottom walk of the currently loaded page, scrolling by
 * 1/divisor of the container's height each step, until the container
 * genuinely bottoms out and stops producing new ids. */
async function scrollAndCollectOnePass(page: Page, divisor: number, signal: AbortSignal): Promise<string[]> {
  await scrollToTop(page)
  await sleep(400, signal)

  let ids: string[] = []
  let consecutiveNoNew = 0
  let steps = 0
  while (!signal.aborted) {
    const domIds = await readPageIdsOnce(page)
    const before = ids.length
    ids = mergeChecklistIds(ids, domIds)
    const gained = ids.length - before
    consecutiveNoNew = gained === 0 ? consecutiveNoNew + 1 : 0

    const atBottom = await isScrollContainerAtBottom(page)
    if (shouldStopScrolling(atBottom, consecutiveNoNew, ids.length)) break

    steps++
    if (steps >= MAX_SCROLL_STEPS_PER_PASS) {
      logger.warn(
        { collected: ids.length, steps, divisor },
        'search: hit the per-pass scroll-step cap without the container reporting bottom — scroll-container detection may be wrong for this page',
      )
      pushLog(SEARCH_TAB, `Gave up scrolling this pass after ${MAX_SCROLL_STEPS_PER_PASS} steps (collected ${ids.length}) — the scroll container may not be what was expected.`)
      break
    }
    await scrollByFraction(page, divisor, signal)
  }
  return ids
}

/** Collects every job id on the currently loaded page. First pass uses
 * half-height scroll steps (50% viewport overlap between reads — a card
 * fully visible in one read is still at least partially rendered in the
 * next). If that undercounts against the expected FULL_PAGE_SIZE without a
 * genuine end-of-results signal, one retry pass runs with quarter-height
 * steps as a finer-grained backstop. Bounded to at most 2 passes. */
async function collectPageIds(page: Page, signal: AbortSignal): Promise<string[]> {
  const divisors = [2, 4]
  let ids: string[] = []
  for (let i = 0; i < divisors.length; i++) {
    ids = await scrollAndCollectOnePass(page, divisors[i]!, signal)
    if (signal.aborted) return ids
    const isFinalAttempt = i === divisors.length - 1
    if (isFinalAttempt || !shouldRetryPageCollection(ids.length, ids.length === 0)) return ids
    pushLog(SEARCH_TAB, `Page returned only ${ids.length}/${FULL_PAGE_SIZE} job(s) — retrying with finer scroll steps.`)
    logger.warn({ collected: ids.length }, 'search: page undercounted, retrying with finer scroll steps')
  }
  return ids
}

/** Batch dedupe check — a single `id IN (...)` query per page instead of one
 * query per id, now that nothing needs a per-id tool round-trip. */
async function filterUnseenJobIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const db = getDb()
  const rows = await db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, ids))
  const known = new Set(rows.map((r) => r.id))
  return ids.filter((id) => !known.has(id))
}

/** Walks every page of one search URL: goto (page 0 is already loaded by
 * openOwnTab, later pages via the &start=N URL param), collect that page's
 * ids, queue the new ones for judgment, decide whether another page follows.
 * No LLM in this path at all — deterministic code only, so there is nothing
 * here that can "stop early" the way an agent.generate() call could. */
async function scanOneUrl(entry: ScanUrlEntry, ctx: ScanRunContext, browser: AgentBrowser, cdpUrl: string, ownTab: OwnedTab): Promise<'ok' | 'aborted'> {
  let pageIndex = 0
  let previousPageIds: string[] = []

  while (pageIndex < MAX_PAGES_PER_URL) {
    if (ctx.signal.aborted) return 'aborted'

    await reclaimOwnTab(browser, cdpUrl, ownTab)
    const manager = await browser.getManagerForThread()
    const page = manager.getPage()

    if (pageIndex > 0) {
      pushLog(SEARCH_TAB, `Loading page ${pageIndex + 1}...`)
      const sep = entry.url.includes('?') ? '&' : '?'
      await page.goto(`${entry.url}${sep}start=${pageIndex * FULL_PAGE_SIZE}`, { waitUntil: 'load' })
    }
    // Let the virtualized list start rendering before reading anything.
    await sleep(1200, ctx.signal)
    if (ctx.signal.aborted) return 'aborted'

    const checkpointQuestion = detectCheckpointUrl(page.url())
    if (checkpointQuestion) {
      pushLog(SEARCH_TAB, `Needs input: ${checkpointQuestion}`)
      const answer = await waitForAnswer(SEARCH_TAB, checkpointQuestion)
      setAgentStatus(SEARCH_TAB, 'running', 'scanning...')
      pushLog(SEARCH_TAB, `Got answer: ${answer} — retrying this page.`)
      continue // retry the same pageIndex from scratch
    }

    const pageIds = await collectPageIds(page, ctx.signal)
    pushLog(SEARCH_TAB, `Page ${pageIndex + 1}: found ${pageIds.length} job(s).`)

    if (pageIds.length > 0) {
      ctx.totalIdsSeen += pageIds.length
      const newIds = await filterUnseenJobIds(pageIds)
      ctx.alreadySeen += pageIds.length - newIds.length
      for (const id of newIds) {
        await enqueueJudgeJob(id, entry.url)
        ctx.queuedForJudge++
      }
      if (newIds.length > 0) {
        pushLog(SEARCH_TAB, `Queued ${newIds.length} new job(s) for judgment (${pageIds.length - newIds.length} already seen).`)
      }
    }

    const done = isLastPage(pageIds, previousPageIds)
    previousPageIds = pageIds
    if (done) return 'ok'
    if (ctx.signal.aborted) return 'aborted'

    // Polite pause between page loads so back-to-back pagination doesn't look
    // like a burst to LinkedIn.
    await sleep(randomNavDelayMs(), ctx.signal)
    pageIndex++
  }

  logger.warn({ url: entry.url, pages: MAX_PAGES_PER_URL }, 'search: hit max-pages safety cap for this URL')
  pushLog(SEARCH_TAB, `Hit the ${MAX_PAGES_PER_URL}-page safety cap for this URL — stopping here.`)
  return 'ok'
}

export interface SearchRunResult {
  queuedForJudge: number
  urlsTried: string[]
}

export function runSearchUrls(entries: ScanUrlEntry[]): Promise<SearchRunResult> {
  const run = runSearchUrlsInner(entries)
  activeRunPromise = run.finally(() => {
    activeRunPromise = null
  })
  return run
}

async function runSearchUrlsInner(entries: ScanUrlEntry[]): Promise<SearchRunResult> {
  if (isSearchRunning()) throw new Error('A search is already running')
  if (entries.length === 0) {
    pushLog(SEARCH_TAB, 'No search URLs to run.')
    return { queuedForJudge: 0, urlsTried: [] }
  }

  const abort = new AbortController()
  activeAbort = abort

  const db = getDb()
  const runId = randomUUID()
  await db.insert(searchRuns).values({ id: runId, urlsTried: [] })

  const ctx: ScanRunContext = { signal: abort.signal, totalIdsSeen: 0, alreadySeen: 0, queuedForJudge: 0 }
  const cdpUrl = getSharedCdpUrl()

  try {
    const browser = getSearchBrowser()
    const triedUrls: string[] = []

    for (const entry of entries) {
      if (abort.signal.aborted) break

      setAgentStatus(SEARCH_TAB, 'running', 'scanning...')
      pushLog(SEARCH_TAB, `Scanning ${entry.url}`)
      triedUrls.push(entry.url)

      // '/jobs/search' distinguishes this URL's results tab from the login
      // tabs (feed/inbox) and from any easy-apply/judge tab (always
      // '/jobs/view/'). Reused across every URL in this run (and across
      // runs) — navigated in place, never closed between URLs.
      let ownTab: OwnedTab
      try {
        ownTab = await ensureSearchTab(browser, cdpUrl, entry.url, '/jobs/search')
      } catch (err) {
        pushLog(SEARCH_TAB, `Could not open ${entry.url}: ${summarizeError(err)} — skipping.`)
        logger.error({ err, url: entry.url }, 'search: failed to open tab')
        continue
      }

      let outcome: 'ok' | 'aborted' = 'ok'
      try {
        outcome = await scanOneUrl(entry, ctx, browser, cdpUrl, ownTab)
      } catch (err) {
        pushLog(SEARCH_TAB, `Error scanning ${entry.url}: ${summarizeError(err)} — moving to next URL.`)
        logger.error({ err, url: entry.url }, 'search: scan failed')
      }

      await db
        .update(searchRuns)
        .set({
          urlsTried: triedUrls,
          scannedCount: ctx.totalIdsSeen,
          relevantCount: ctx.queuedForJudge,
          skippedCount: ctx.alreadySeen,
        })
        .where(eq(searchRuns.id, runId))

      if (outcome === 'aborted') {
        pushLog(SEARCH_TAB, 'Search aborted mid-step.')
        break
      }

      // Polite pause between search URLs so back-to-back page loads don't
      // look like a burst to LinkedIn.
      await sleep(randomNavDelayMs(), abort.signal)
    }

    await db.update(searchRuns).set({ finishedAt: new Date() }).where(eq(searchRuns.id, runId))

    const stopped = abort.signal.aborted ? ' (stopped early)' : ''
    const summary =
      ctx.queuedForJudge === 0
        ? `Finished searching ${triedUrls.length} URL(s)${stopped}. No new jobs queued for judgment.`
        : `Finished searching ${triedUrls.length} URL(s)${stopped}. Queued ${ctx.queuedForJudge} new job(s) for judgment (${ctx.alreadySeen} already seen).`
    pushLog(SEARCH_TAB, summary)
    logger.info(
      { totalIdsSeen: ctx.totalIdsSeen, queuedForJudge: ctx.queuedForJudge, alreadySeen: ctx.alreadySeen, urls: triedUrls.length },
      'search: run finished',
    )
    setAgentStatus(SEARCH_TAB, 'idle', null)

    return { queuedForJudge: ctx.queuedForJudge, urlsTried: triedUrls }
  } finally {
    activeAbort = null
    // Always drop back to idle — without this, a thrown error (surfaced to the
    // user by the command layer) left the sidebar stuck on "running" forever.
    setAgentStatus(SEARCH_TAB, 'idle', null)
  }
}
