import { chromium, type Browser } from 'playwright-core'

/**
 * agent-browser's own tab tracking (tab-guard.ts's switch/open calls) only
 * updates its internal "which tab do subsequent commands target" pointer —
 * confirmed by reading node_modules/agent-browser/dist/browser.js: switchTo()
 * and newTab() never call Playwright's page.bringToFront(). So a tab that's
 * logically "ours" can still sit visually backgrounded behind whatever tab a
 * different agent last switched to. Chrome throttles background tabs
 * (requestAnimationFrame/timers deprioritized), which can make a JS-heavy
 * page — LinkedIn's Easy Apply modal — render or behave inconsistently while
 * it isn't the front tab.
 *
 * @mastra/agent-browser's getPage()/getActivePage() are declared `private` in
 * its own type definitions, so there's no way to reach the real Playwright
 * Page through the AgentBrowser instances the agents already hold. This opens
 * its own independent, read-only CDP connection via vanilla playwright-core
 * (not agent-browser's BrowserManager) purely to call bringToFront() —
 * because it doesn't go through BrowserManager, it never registers the
 * `context.on('page', ...)` auto-switch listener that causes the tab-hijack
 * problem tab-guard.ts otherwise guards against, so it can't make that
 * problem worse.
 *
 * Keyed by cdpUrl (not a single global) — search/career-scan and easy-apply
 * can each be talking to a DIFFERENT real browser process (see
 * easy-apply-session.ts), so a connection to one must never be used to look
 * for a tab that lives in the other.
 */
const focusBrowsers = new Map<string, Browser>()
const connecting = new Map<string, Promise<Browser>>()

async function getFocusBrowser(cdpUrl: string): Promise<Browser> {
  const existing = focusBrowsers.get(cdpUrl)
  if (existing?.isConnected()) return existing

  const pending = connecting.get(cdpUrl)
  if (pending) return pending

  const connect = chromium.connectOverCDP(cdpUrl).then((browser) => {
    focusBrowsers.set(cdpUrl, browser)
    connecting.delete(cdpUrl)
    return browser
  })
  connecting.set(cdpUrl, connect)
  return connect
}

/** Brings the real Chrome tab whose URL contains `urlFragment` (in the
 * browser reachable at `cdpUrl`) to the OS-visible front. Best-effort — a
 * focus nudge failing must never break the actual automation step it's
 * supporting. */
export async function bringTabToFront(cdpUrl: string, urlFragment: string): Promise<void> {
  try {
    const browser = await getFocusBrowser(cdpUrl)
    for (const context of browser.contexts()) {
      const page = context.pages().find((p) => p.url().includes(urlFragment))
      if (page) {
        await page.bringToFront()
        return
      }
    }
  } catch {
    // Best-effort — the caller's own tab-tracking (tab-guard.ts) is still
    // correct even if the OS-visual focus nudge fails.
  }
}
