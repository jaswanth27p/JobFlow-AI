import type { AgentBrowser } from '@mastra/agent-browser'
import { bringTabToFront } from './tab-focus.ts'

/**
 * agent-browser's BrowserManager auto-switches its "active tab" pointer to
 * ANY newly-opened tab in the shared browser (setupContextTracking's
 * `context.on('page', ...)` in node_modules/agent-browser/dist/browser.js) —
 * and this fires on EVERY AgentBrowser instance connected to that browser via
 * CDP, not just the one that opened the tab. Concretely: the search agent
 * opening its next search-results tab silently re-points the easy-apply
 * agent's "current tab" at that tab too (and vice versa), so an agent that
 * just calls browser_goto/browser_click without re-asserting its own tab can
 * end up acting on whatever tab a *different* agent most recently opened.
 *
 * These helpers give an agent a tab it owns outright: opened by our own code
 * (never left to the LLM, which has no way to defend against the hijack),
 * re-asserted as active before every step, matched back by a URL fragment
 * (not a raw index — indices stay parallel across managers in practice, but
 * matching by content is what actually survives a tab that got closed
 * elsewhere and shifted indices).
 */
export interface OwnedTab {
  matchFragment: string
}

interface TabListEntry {
  index: number
  url: string
  title: string
  active: boolean
}

async function findOwnTab(browser: AgentBrowser, tab: OwnedTab): Promise<TabListEntry | undefined> {
  // The LLM-facing tool wrapper for every browser_* tool calls
  // browser.ensureReady() before dispatching (see @mastra/agent-browser's
  // createAgentBrowserTools) — that's what actually launches the underlying
  // BrowserManager on first use. Calling browser.tabs() directly, bypassing
  // that wrapper, skipped it entirely and failed every job with "Browser was
  // not initialized." ensureReady() is a no-op once already launched, so this
  // is safe to call on every access, not just the first.
  await browser.ensureReady()
  const result = await browser.tabs({ action: 'list' })
  if (!result.success) return undefined
  const tabs = (result.tabs ?? []) as TabListEntry[]
  return tabs.find((t) => t.url.includes(tab.matchFragment))
}

export async function openOwnTab(browser: AgentBrowser, cdpUrl: string, url: string, matchFragment: string): Promise<OwnedTab> {
  await browser.ensureReady()
  const result = await browser.tabs({ action: 'new', url })
  if (!result.success) {
    throw new Error(`Failed to open dedicated tab for ${url}: ${result.message}`)
  }
  // browser.tabs() above only updates agent-browser's own bookkeeping — it
  // never brings the tab to the OS-visible front (see tab-focus.ts). Without
  // this, the tab starts life backgrounded whenever another agent's tab is
  // currently frontmost.
  await bringTabToFront(cdpUrl, matchFragment)
  return { matchFragment }
}

/** Call before every agent step (onStepFinish) so a hijacked active-tab
 * pointer — AND the OS-visual front tab, which is a separate thing entirely,
 * see tab-focus.ts — is corrected before the NEXT step acts on the wrong tab.
 * `cdpUrl` must be the SAME browser `browser` itself talks to — passed
 * explicitly rather than looked up, since different agents can now be
 * talking to entirely different browser processes (see easy-apply-session.ts). */
export async function reclaimOwnTab(browser: AgentBrowser, cdpUrl: string, tab: OwnedTab): Promise<void> {
  const own = await findOwnTab(browser, tab)
  if (own && !own.active) {
    await browser.tabs({ action: 'switch', index: own.index })
  }
  await bringTabToFront(cdpUrl, tab.matchFragment)
}

/** Best-effort — closes only the tab matching our own fragment, never
 * whatever happens to be "active" (which may have been hijacked). */
export async function closeOwnTab(browser: AgentBrowser, tab: OwnedTab): Promise<void> {
  try {
    const own = await findOwnTab(browser, tab)
    if (own) await browser.tabs({ action: 'close', index: own.index })
  } catch {
    // Best-effort cleanup — the job's DB outcome is already written regardless.
  }
}
