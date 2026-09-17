import { lookup } from 'node:dns/promises'
import { pushLog, setAgentStatus } from '../state/app-state.ts'
import type { TabId } from '../state/types.ts'

/** DNS resolution of the actual site every agent depends on — cheaper than an
 * HTTP fetch and ties the check directly to "can this agent do anything
 * useful right now", not just "is *some* server on the internet reachable". */
const CONNECTIVITY_CHECK_HOST = 'www.linkedin.com'
const CONNECTIVITY_CHECK_TIMEOUT_MS = 5000

/** How often to re-check while paused offline. One minute matches how the
 * user actually experiences an outage (not so tight it hammers DNS, not so
 * loose that a restored connection sits idle for many minutes). */
const NETWORK_RETRY_INTERVAL_MS = 60_000

export async function isNetworkOnline(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      lookup(CONNECTIVITY_CHECK_HOST),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('connectivity check timed out')), CONNECTIVITY_CHECK_TIMEOUT_MS)
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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

/** Blocks the caller until internet connectivity is back, checking once every
 * NETWORK_RETRY_INTERVAL_MS. Call this before any network-dependent step
 * (opening/navigating an owned tab) in the search/judge/easy-apply loops — a
 * connectivity drop then pauses that one agent in place instead of racing
 * through its entire queue failing every item one after another (which is
 * what used to happen: hundreds of queued jobs burned through and silently
 * dropped in the time it took to notice the outage). Returns 'aborted' if
 * `signal` fires mid-wait (shutdown/stop), so callers can bail out the same
 * way they already do for any other abort. Returns immediately with 'online'
 * if connectivity was never actually lost. */
export async function waitForNetwork(tab: TabId, signal?: AbortSignal): Promise<'online' | 'aborted'> {
  if (await isNetworkOnline()) return 'online'

  pushLog(tab, 'No internet connection detected — pausing here, will check again every minute until it is back.')
  setAgentStatus(tab, 'running', 'paused: no internet connection')

  while (!(await isNetworkOnline())) {
    if (signal?.aborted) return 'aborted'
    await sleep(NETWORK_RETRY_INTERVAL_MS, signal)
    if (signal?.aborted) return 'aborted'
  }

  pushLog(tab, 'Internet connection restored — resuming.')
  return 'online'
}
