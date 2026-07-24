import { getCurrentConfig } from '../config/current.ts'
import { appState, pushLog } from '../state/app-state.ts'
import { runSearchUrls, isSearchRunning, stopSearchAndWait } from './search-agent.ts'
import { startEasyApplyWorker } from '../queues/easy-apply-worker.ts'
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

export type AutoMode = 'loop' | 'interval'

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

interface SchedulerState {
  mode: AutoMode | null
  intervalMs: number | null
  intervalHandle: ReturnType<typeof setInterval> | null
  loopActive: boolean
  tickRunning: boolean
}

const state: SchedulerState = {
  mode: null,
  intervalMs: null,
  intervalHandle: null,
  loopActive: false,
  tickRunning: false,
}

/** Tracks whatever single run is currently in flight, regardless of mode, so
 * stopAutoModeAndWait can await it on shutdown without caring which mode was active. */
let activeWorkPromise: Promise<void> | null = null

/** Aborts the between-cycle cooldown sleep in loop mode so /auto-off (and
 * shutdown) doesn't have to wait out the full loopCooldownMs to take effect. */
let loopCooldownAbort: AbortController | null = null

export function isAutoModeOn(): boolean {
  return state.mode !== null
}

async function runConfiguredUrls(): Promise<void> {
  if (isSearchRunning()) {
    pushLog(SEARCH_TAB, 'Auto mode: skipping this cycle — a search is already running.')
    return
  }
  const config = getCurrentConfig()
  if (config.mustCheckUrls.length === 0) {
    pushLog(SEARCH_TAB, 'Auto mode: no configured URLs to scan — skipping this cycle.')
    return
  }
  try {
    await runSearchUrls(config.mustCheckUrls)
  } catch (err) {
    pushLog(SEARCH_TAB, `Auto mode: cycle failed: ${summarizeError(err)}`)
    logger.error({ err }, 'auto mode: cycle failed')
  }
}

async function runLoop(): Promise<void> {
  while (state.mode === 'loop' && state.loopActive) {
    const work = runConfiguredUrls()
    activeWorkPromise = work
    await work

    if (state.mode !== 'loop' || !state.loopActive) break

    // Cooldown between full cycles — without this, loop mode reopens the same
    // search URLs back-to-back nonstop, which reads as bot behavior to
    // LinkedIn (real rate-limit/ban risk). Abortable so /auto-off is instant.
    const cooldownMs = Math.max(60_000, appState.settings.loopCooldownMs)
    pushLog(SEARCH_TAB, `Auto mode: cycle finished — next loop cycle in ~${formatDuration(cooldownMs)}.`)
    loopCooldownAbort = new AbortController()
    await sleep(cooldownMs, loopCooldownAbort.signal)
    loopCooldownAbort = null
  }
}

async function runIntervalTick(): Promise<void> {
  if (state.tickRunning) {
    pushLog(SEARCH_TAB, 'Auto mode: previous interval cycle is still running — skipping this tick.')
    return
  }
  state.tickRunning = true
  const work = (async () => {
    try {
      await runConfiguredUrls()
      if (state.mode === 'interval' && state.intervalMs !== null) {
        pushLog(SEARCH_TAB, `Auto mode: cycle finished — next tick in ~${formatDuration(state.intervalMs)}.`)
      }
    } finally {
      state.tickRunning = false
    }
  })()
  activeWorkPromise = work
  await work
}

/** Starts the easy-apply queue worker if it isn't already running — idempotent
 * no-op when already started, so this is safe to call unconditionally. */
function ensureApplyWorkersRunning(): void {
  startEasyApplyWorker()
}

export function startAutoMode(mode: AutoMode, intervalMs?: number): void {
  if (state.mode !== null) {
    pushLog(SEARCH_TAB, `Auto mode is already on (${state.mode}). Use /auto-off first.`)
    return
  }

  ensureApplyWorkersRunning()

  if (mode === 'loop') {
    state.mode = 'loop'
    state.loopActive = true
    pushLog(SEARCH_TAB, 'Auto mode: loop started (running configured search URLs continuously).')
    void runLoop()
    return
  }

  // mode === 'interval'
  if (!intervalMs) throw new Error('intervalMs is required for interval mode')
  state.mode = 'interval'
  state.intervalMs = intervalMs
  pushLog(SEARCH_TAB, `Auto mode: interval started, every ${formatDuration(intervalMs)}.`)
  state.intervalHandle = setInterval(() => {
    void runIntervalTick()
  }, intervalMs)
  void runIntervalTick()
}

export function stopAutoMode(): void {
  if (state.mode === null) {
    pushLog(SEARCH_TAB, 'Auto mode is not on.')
    return
  }
  pushLog(SEARCH_TAB, 'Auto mode: stopping (any in-flight cycle will finish on its own).')
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle)
    state.intervalHandle = null
  }
  state.loopActive = false
  state.mode = null
  state.intervalMs = null
  loopCooldownAbort?.abort()
}

/** Silent variant for app shutdown — no user-facing log, just tears the scheduler down. */
function stopAutoModeSilently(): void {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle)
    state.intervalHandle = null
  }
  state.loopActive = false
  state.mode = null
  state.intervalMs = null
  loopCooldownAbort?.abort()
}

/** For app shutdown. Order matters here: stop scheduling FIRST (so the loop/interval
 * driver never starts another cycle once the current one ends), then abort+wait for
 * whatever runSearchUrls call is actually in flight via search-agent's own
 * stopSearchAndWait (shared AbortController — covers both manually-triggered and
 * scheduler-triggered runs), and only then await activeWorkPromise as a final catch-all. */
export async function stopAutoModeAndWait(): Promise<void> {
  stopAutoModeSilently()
  await stopSearchAndWait()
  if (activeWorkPromise) {
    await activeWorkPromise.catch(() => {})
  }
}
