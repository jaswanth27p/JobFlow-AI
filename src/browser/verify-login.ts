import { setSessionStatus, isUnlocked, pushLog, appState } from '../state/app-state.ts'
import { getBrowserServerPort, browserServerUrl } from './session.ts'
import { logger } from '../utils/logger.ts'

let autoVerifyTimer: ReturnType<typeof setInterval> | null = null
let ticking = false

function isLinkedinPageUrl(url: string): boolean {
  const pageUrl = url.toLowerCase()
  return (
    pageUrl.includes('linkedin.com/feed') ||
    pageUrl.includes('linkedin.com/mynetwork') ||
    pageUrl.includes('linkedin.com/jobs') ||
    pageUrl.includes('linkedin.com/messaging') ||
    pageUrl.includes('linkedin.com/notifications') ||
    (pageUrl.includes('linkedin.com') && !pageUrl.includes('/login') && !pageUrl.includes('/checkpoint'))
  )
}

function isGmailPageUrl(url: string): boolean {
  const gmailUrl = url.toLowerCase()
  return gmailUrl.includes('mail.google.com/mail/') && !gmailUrl.includes('/signin')
}

async function fetchTabUrl(serverPort: number, tab: 0 | 1): Promise<string> {
  const res = (await fetch(browserServerUrl(`/page-url?tab=${tab}`, serverPort))
    .then((r) => r.json())
    .catch(() => ({ url: '' }))) as { url?: string }
  return res.url || ''
}

/**
 * Poll the bootstrap browser for LinkedIn (tab 0) login every `intervalMs`,
 * stopping as soon as it's confirmed. Gmail (tab 1) is intentionally NOT
 * polled here — it's optional and currently vestigial (no agent reads it,
 * isUnlocked() gates on LinkedIn only), and a fresh Gmail login can take
 * anywhere from seconds to "never" for a given run, which used to keep this
 * loop (and an extra HTTP check every tick) running indefinitely for no
 * benefit. Gmail's status is still checked, just only on demand via the
 * manual /verify-login command (see verifyLogin below). Safe to call once; a
 * second call while already polling is a no-op.
 */
export function startLoginAutoVerify(intervalMs = 5000): void {
  if (autoVerifyTimer) return

  const tick = async () => {
    if (ticking) return
    if (isUnlocked()) {
      stopLoginAutoVerify()
      return
    }
    ticking = true
    try {
      let port: number
      try {
        port = getBrowserServerPort()
      } catch {
        return // browser server not up yet; try again next tick
      }
      const linkedin = isLinkedinPageUrl(await fetchTabUrl(port, 0))
      if (linkedin && !appState.session.linkedin) {
        setSessionStatus('linkedin', true)
        pushLog(appState.activeTab, 'Login verified automatically: LinkedIn connected.')
        logger.info('auto-verify: LinkedIn logged in')
      }
      if (linkedin) stopLoginAutoVerify()
    } catch (err) {
      logger.warn({ err }, 'auto-verify: tick failed')
    } finally {
      ticking = false
    }
  }

  autoVerifyTimer = setInterval(tick, intervalMs)
  void tick() // check immediately, don't wait a full interval for the first one
}

export function stopLoginAutoVerify(): void {
  if (autoVerifyTimer) {
    clearInterval(autoVerifyTimer)
    autoVerifyTimer = null
  }
}

/** Used by the manual /verify-login command — checks both tabs on demand
 * (unlike the auto-poll loop above, which only ever checks LinkedIn). */
export async function verifyLogin(serverPort: number): Promise<{ linkedin: boolean; gmail: boolean }> {
  const [linkedinUrl, gmailUrl] = await Promise.all([fetchTabUrl(serverPort, 0), fetchTabUrl(serverPort, 1)])
  return { linkedin: isLinkedinPageUrl(linkedinUrl), gmail: isGmailPageUrl(gmailUrl) }
}
