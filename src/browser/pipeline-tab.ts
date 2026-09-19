import { AgentBrowser } from '@mastra/agent-browser'
import { noopLogger } from '@mastra/core/logger'
import { getSharedCdpUrl } from './session.ts'
import { openOwnTab, navigateOwnTab, closeOwnTab, isBrowserConnectionError, isOwnedTabGoneError, type OwnedTab } from './tab-guard.ts'
import { logger } from '../utils/logger.ts'

/**
 * The single non-login tab the whole auto-mode pipeline (search, scrape,
 * judge-triggered easy-apply) shares — see docs/superpowers/specs/
 * 2026-09-19-single-tab-sequential-pipeline-design.md. Previously each stage
 * ran its own dedicated Chrome process (scrape-session.ts, easy-apply-session.ts)
 * so up to three browser windows could be open and navigating at once, which
 * reads nothing like a real user and is part of what got LinkedIn to throttle
 * the account (see docs/superpowers/specs/2026-09-18-judge-scrape-split-design.md).
 * All three stages now attach to the SAME bootstrap browser (getSharedCdpUrl())
 * and take turns navigating this ONE tab in place — scrape-worker.ts's
 * await-judge-then-apply gating is what guarantees only one stage ever
 * touches it at a time.
 */
let pipelineBrowser: AgentBrowser | null = null
let pipelineTab: OwnedTab | null = null

export function getPipelineBrowser(): { browser: AgentBrowser; cdpUrl: string } {
  const cdpUrl = getSharedCdpUrl()
  if (!pipelineBrowser) {
    pipelineBrowser = new AgentBrowser({
      cdpUrl,
      scope: 'shared',
      headless: false,
      // browser_tabs/browser_screenshot withheld — see easy-apply-agent.ts's
      // Agent, the only phase that exposes this browser to an LLM's own tool
      // calls. Search and scrape never go through tool-dispatch at all (plain
      // page.evaluate/browser.snapshot/browser.evaluate calls), so this
      // restriction is a no-op for them.
      excludeTools: ['browser_screenshot', 'browser_tabs'],
    })
    // AgentBrowser has its own ConsoleLogger — without this, tool-level
    // errors (e.g. a Playwright navigation timeout) still write raw
    // ANSI text to stdout and corrupt the opentui TUI frame.
    pipelineBrowser.__setLogger(noopLogger)
  }
  return { browser: pipelineBrowser, cdpUrl }
}

/** Reuses the one pipeline tab across every phase and every job (navigate in
 * place) — never opens a second tab while this one is still around. See
 * navigateOwnTab's doc comment (tab-guard.ts) for why reuse beats open/close
 * per item. */
export async function ensurePipelineTab(url: string, matchFragment: string): Promise<OwnedTab> {
  const { browser, cdpUrl } = getPipelineBrowser()
  if (pipelineTab) {
    try {
      pipelineTab = await navigateOwnTab(browser, cdpUrl, pipelineTab, url, matchFragment)
      return pipelineTab
    } catch (err) {
      // Only a genuinely-gone tab (or dead browser) warrants abandoning it and
      // opening a new one — a plain nav failure (offline, DNS, timeout) means
      // the tab is still there, so reopening would leak it. See
      // isOwnedTabGoneError's doc comment (tab-guard.ts) for the full story.
      // A dead BOOTSTRAP browser itself has no relaunch path in this session
      // (session.ts's getSharedCdpUrl throws until the app is restarted) —
      // isBrowserConnectionError here just means the fresh openOwnTab call
      // below will fail the same way, which is the correct, loud failure.
      if (!isBrowserConnectionError(err) && !isOwnedTabGoneError(err)) throw err
      logger.warn({ err }, 'pipeline: could not reuse existing tab, opening a fresh one')
      pipelineTab = null
    }
  }
  pipelineTab = await openOwnTab(browser, cdpUrl, url, matchFragment)
  return pipelineTab
}

/** Closes the one pipeline tab (if any) at the end of a full auto-mode cycle,
 * once search+scrape+judge+apply have all drained — leaves only the two
 * login tabs open between cycles. Best-effort: closeOwnTab already swallows
 * its own failures (see tab-guard.ts). */
export async function closePipelineTab(): Promise<void> {
  if (!pipelineTab) return
  const { browser } = getPipelineBrowser()
  await closeOwnTab(browser, pipelineTab)
  pipelineTab = null
}
