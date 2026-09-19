import { pushLog } from '../state/app-state.ts'
import { runSearchUrls, isSearchRunning, stopSearchAndWait, type ScanUrlEntry } from './search-agent.ts'
import { startEasyApplyWorker } from '../queues/easy-apply-worker.ts'
import { startJudgeWorker } from '../queues/judge-worker.ts'
import { startScrapeWorker, stopScrapeWorker } from '../queues/scrape-worker.ts'
import { getScrapeQueueCounts } from '../queues/scrape-queues.ts'
import { closePipelineTab } from '../browser/pipeline-tab.ts'
import { logger } from '../utils/logger.ts'
import { summarizeError } from '../utils/error-summary.ts'
import type { TabId } from '../state/types.ts'

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

const SEARCH_TAB: TabId = 'search'

/** Parses a duration string into milliseconds. Accepts `<n>h`, `<n>m`, combined
 * `<n>h<n>m`, or a bare number (interpreted as hours). Returns null (not a throw) on
 * unparsable input or anything under the 1-minute floor, so callers can log a usage
 * message instead of surfacing a parse error. Exported for unit testing. */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const hours = Number(trimmed)
    return hours > 0 ? hours * 3_600_000 : null
  }

  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/i.exec(trimmed)
  if (!match || (!match[1] && !match[2])) return null

  const hours = match[1] ? Number(match[1]) : 0
  const minutes = match[2] ? Number(match[2]) : 0
  const ms = hours * 3_600_000 + minutes * 60_000
  return ms >= 60_000 ? ms : null
}

/** Human-readable duration for log lines, e.g. 5400000 -> "1h30m". Exported for testing. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h > 0 && m > 0) return `${h}h${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

/** How long to wait before the next cycle, given how long the just-finished
 * one took against the target duration — zero if it met or exceeded the
 * target. Exported for direct unit testing (see search-scheduler-timing.test.ts). */
export function nextCycleWaitMs(elapsedMs: number, durationMs: number): number {
  return Math.max(0, durationMs - elapsedMs)
}

interface SchedulerState {
  on: boolean
  durationMs: number | null
  /** The URL entries and group label picked when /auto-on was started —
   * captured once, not re-read from config each cycle, so a later
   * /reload-config or config edit never silently alters an in-flight
   * rotation; only the next /auto-on start picks up new groups. */
  entries: ScanUrlEntry[]
  groupLabel: string
}

const state: SchedulerState = {
  on: false,
  durationMs: null,
  entries: [],
  groupLabel: '',
}

/** Tracks whatever cycle is currently in flight so stopAutoModeAndWait can
 * await it on shutdown. */
let activeWorkPromise: Promise<void> | null = null

/** Aborts the between-cycle wait so /auto-off (and shutdown) doesn't have to
 * wait out the full remaining duration to take effect. */
let cooldownAbort: AbortController | null = null

/** Aborts the current cycle's drain-wait poll loop on shutdown — see
 * stopAutoModeAndWait. A soft /auto-off deliberately does NOT abort this: the
 * in-flight cycle (and the easy-apply/scrape/judge workers it started) keeps
 * running to completion, same as today's /auto-off leaving the easy-apply
 * queue worker running. */
let cycleAbort: AbortController | null = null

export function isAutoModeOn(): boolean {
  return state.on
}

/** Polls the scrape queue until it's fully drained (no waiting or active
 * job). Because scrape-worker.ts's processor blocks on judge (and any apply
 * it triggers) finishing before its own job resolves — see
 * docs/superpowers/specs/2026-09-19-single-tab-sequential-pipeline-design.md —
 * an empty scrape queue means the ENTIRE per-job chain has resolved for every
 * job this cycle found, not just the scrape step. No need to separately poll
 * the judge/apply queues. */
async function waitForDrain(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const counts = await getScrapeQueueCounts()
    if (counts.waiting === 0 && counts.active === 0 && counts.delayed === 0) return
    await sleep(2000, signal)
  }
}

/** One full cycle: search runs to completion first — scrape/judge/apply are
 * deliberately not consuming yet (see the stopScrapeWorker call below), since
 * they'd otherwise grab the one shared pipeline tab out from under an
 * in-progress search page load the instant search enqueues the first job id.
 * Once search returns, the scrape worker (re)starts and every job it found is
 * scraped/judged/applied to, one at a time, before this resolves. */
async function runCycle(signal: AbortSignal): Promise<void> {
  // Catch-all so ANY failure after the search phase (a Redis blip during
  // waitForDrain's poll loop, a throw from startScrapeWorker/closePipelineTab)
  // can't reject runAutoLoop's promise and silently kill the whole rotation —
  // the pre-refactor scheduler's runConfiguredUrls had the same catch-all.
  try {
    if (isSearchRunning()) {
      pushLog(SEARCH_TAB, 'Auto mode: skipping this cycle — a search is already running.')
      return
    }
    if (state.entries.length === 0) {
      pushLog(SEARCH_TAB, 'Auto mode: no configured URLs to scan — skipping this cycle.')
      return
    }

    // No-op if it was already stopped (e.g. the very first cycle).
    await stopScrapeWorker()

    try {
      await runSearchUrls(state.entries)
    } catch (err) {
      pushLog(SEARCH_TAB, `Auto mode: search phase failed: ${summarizeError(err)}`)
      logger.error({ err }, 'auto mode: search phase failed')
    }

    if (signal.aborted) return

    // Judge/apply are session-lifetime workers (idempotent no-op once started)
    // — they only ever react to what the scrape worker feeds them, and the
    // scrape worker only runs during this drain phase, so it's safe to leave
    // them running continuously rather than starting/stopping them every cycle.
    startEasyApplyWorker()
    startJudgeWorker()
    startScrapeWorker()

    await waitForDrain(signal)
    await closePipelineTab()
  } catch (err) {
    pushLog(SEARCH_TAB, `Auto mode: cycle failed: ${summarizeError(err)}`)
    logger.error({ err }, 'auto mode: cycle failed')
  }
}

async function runAutoLoop(): Promise<void> {
  while (state.on) {
    const t0 = Date.now()
    cycleAbort = new AbortController()
    const work = runCycle(cycleAbort.signal)
    activeWorkPromise = work
    await work
    cycleAbort = null

    if (!state.on) break

    const elapsed = Date.now() - t0
    const durationMs = state.durationMs!
    const waitMs = nextCycleWaitMs(elapsed, durationMs)
    if (waitMs > 0) {
      pushLog(SEARCH_TAB, `Auto mode: cycle finished in ~${formatDuration(elapsed)} — next cycle in ~${formatDuration(waitMs)}.`)
    } else {
      pushLog(
        SEARCH_TAB,
        `Auto mode: cycle finished in ~${formatDuration(elapsed)}, at or past the ${formatDuration(durationMs)} target — starting the next cycle immediately.`,
      )
    }
    cooldownAbort = new AbortController()
    await sleep(waitMs, cooldownAbort.signal)
    cooldownAbort = null
  }
}

export function startAutoMode(entries: ScanUrlEntry[], groupLabel: string, durationMs: number): void {
  if (state.on) {
    pushLog(SEARCH_TAB, 'Auto mode is already on. Use /auto-off first.')
    return
  }

  state.on = true
  state.durationMs = durationMs
  state.entries = entries
  state.groupLabel = groupLabel
  pushLog(SEARCH_TAB, `Auto mode started, target cycle ~${formatDuration(durationMs)} (group: ${groupLabel}).`)
  void runAutoLoop()
}

export function stopAutoMode(): void {
  if (!state.on) {
    pushLog(SEARCH_TAB, 'Auto mode is not on.')
    return
  }
  pushLog(SEARCH_TAB, 'Auto mode: stopping (any in-flight cycle will finish on its own).')
  state.on = false
  state.durationMs = null
  cooldownAbort?.abort()
}

function stopAutoModeSilently(): void {
  state.on = false
  state.durationMs = null
  cooldownAbort?.abort()
}

/** For app shutdown. Order matters here: stop scheduling FIRST (so the loop
 * never starts another cycle once the current one ends), abort the
 * drain-wait poll (cycleAbort) so it doesn't hang waiting for a queue nothing
 * will ever drain again once the workers are torn down elsewhere in
 * cleanup(), abort+wait for whatever search is actually in flight via
 * search-agent's own stopSearchAndWait (shared AbortController — covers both
 * manually-triggered and scheduler-triggered runs), and only then await
 * activeWorkPromise as a final catch-all. */
export async function stopAutoModeAndWait(): Promise<void> {
  stopAutoModeSilently()
  cycleAbort?.abort()
  await stopSearchAndWait()
  if (activeWorkPromise) {
    await activeWorkPromise.catch(() => {})
  }
}
