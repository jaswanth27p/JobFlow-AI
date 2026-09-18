import { describe, test, expect, beforeAll } from 'bun:test'
import { navigateOwnTab, openOwnTab, closeStrayTabs, isBrowserConnectionError } from '../../../src/browser/tab-guard.ts'
import { setCurrentConfig } from '../../../src/config/current.ts'
import type { AppConfig } from '../../../src/config/schema.ts'
import type { AgentBrowser } from '@mastra/agent-browser'

interface TabListEntry {
  index: number
  url: string
  title: string
  active: boolean
}

function fakeBrowser(gotoMessage: string, tabs: TabListEntry[]) {
  const calls: Array<Record<string, unknown>> = []
  const browser = {
    ensureReady: async () => {},
    tabs: async (opts: Record<string, unknown>) => {
      calls.push(opts)
      if (opts.action === 'list') return { success: true, tabs }
      return { success: true }
    },
    goto: async () => ({ success: false, message: gotoMessage }),
  }
  return { browser: browser as unknown as AgentBrowser, calls }
}

describe('isBrowserConnectionError', () => {
  test('a renderer "Page crashed" goto failure is treated as an unusable handle', () => {
    const err = new Error(
      'Failed to navigate owned tab to https://www.linkedin.com/jobs/view/1/: Goto failed: goto: Page crashed\nCall log:\n  - navigating to "https://www.linkedin.com/jobs/view/1/", waiting until "domcontentloaded"\n',
    )
    expect(isBrowserConnectionError(err)).toBe(true)
  })

  test('a plain navigation failure on a live tab is NOT a connection error', () => {
    const err = new Error('Failed to navigate owned tab to https://x/: Goto failed: goto: net::ERR_INTERNET_DISCONNECTED')
    expect(isBrowserConnectionError(err)).toBe(false)
  })
})

describe('navigateOwnTab', () => {
  test('a crashed tab is closed and the failure reported as a connection error', async () => {
    const tabs: TabListEntry[] = [{ index: 0, url: 'https://www.linkedin.com/jobs/view/1/', title: 'Job', active: true }]
    const { browser, calls } = fakeBrowser('Goto failed: goto: Page crashed', tabs)

    const err = await navigateOwnTab(browser, 'http://127.0.0.1:1', { matchFragment: '/jobs/view/1' }, 'https://www.linkedin.com/jobs/view/1/', '/jobs/view/1').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(isBrowserConnectionError(err)).toBe(true)
    expect(calls.some((c) => c.action === 'close' && c.index === 0)).toBe(true)
  })

  test('a plain nav failure does NOT close the still-live tab', async () => {
    const tabs: TabListEntry[] = [{ index: 0, url: 'https://www.linkedin.com/jobs/view/1/', title: 'Job', active: true }]
    const { browser, calls } = fakeBrowser('Goto failed: goto: net::ERR_INTERNET_DISCONNECTED', tabs)

    await navigateOwnTab(browser, 'http://127.0.0.1:1', { matchFragment: '/jobs/view/1' }, 'https://www.linkedin.com/jobs/view/1/', '/jobs/view/1').catch(() => {})

    expect(calls.some((c) => c.action === 'close')).toBe(false)
  })
})

describe('openOwnTab', () => {
  // bringTabToFront reads autoFocusTabs off the loaded config; without one it
  // throws before its own try/catch. autoFocusTabs:false makes it a no-op.
  beforeAll(() => {
    setCurrentConfig({ autoFocusTabs: false } as unknown as AppConfig)
  })

  test('closes the just-created tab when opening it fails, so retries do not leak tabs', async () => {
    const before: TabListEntry[] = [{ index: 0, url: 'about:blank', title: '', active: false }]
    // `browser_tabs` action "new" = newTab() then goto; when the goto throws
    // the tab is left open even though `success` is false.
    const after: TabListEntry[] = [
      ...before,
      { index: 1, url: 'https://www.linkedin.com/jobs/view/1/', title: '', active: true },
    ]
    const calls: Array<Record<string, unknown>> = []
    let listCount = 0
    const browser = {
      ensureReady: async () => {},
      tabs: async (opts: Record<string, unknown>) => {
        calls.push(opts)
        if (opts.action === 'list') {
          listCount++
          return { success: true, tabs: listCount === 1 ? before : after }
        }
        if (opts.action === 'new') {
          return { success: false, message: 'Tabs failed: goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE' }
        }
        return { success: true }
      },
    } as unknown as AgentBrowser

    const err = await openOwnTab(browser, 'http://127.0.0.1:1', 'https://www.linkedin.com/jobs/view/1/', '/jobs/view/1').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(calls.some((c) => c.action === 'close' && c.index === 1)).toBe(true)
  })

  test('does not close anything when the open succeeds', async () => {
    const tabs: TabListEntry[] = [{ index: 0, url: 'about:blank', title: '', active: true }]
    const calls: Array<Record<string, unknown>> = []
    const browser = {
      ensureReady: async () => {},
      tabs: async (opts: Record<string, unknown>) => {
        calls.push(opts)
        if (opts.action === 'list') return { success: true, tabs }
        return { success: true }
      },
    } as unknown as AgentBrowser

    // autoFocusTabs is off in the test config below, so bringTabToFront no-ops.
    await openOwnTab(browser, 'http://127.0.0.1:1', 'https://www.linkedin.com/jobs/view/1/', '/jobs/view/1')

    expect(calls.some((c) => c.action === 'close')).toBe(false)
  })
})

describe('closeStrayTabs', () => {
  test('closes every tab except the kept fragment, highest index first', async () => {
    const tabs: TabListEntry[] = [
      { index: 0, url: 'https://www.linkedin.com/jobs/view/old/', title: 'old', active: false },
      { index: 1, url: 'https://www.linkedin.com/jobs/view/new/', title: 'new', active: true },
      { index: 2, url: 'about:blank', title: '', active: false },
    ]
    const calls: Array<Record<string, unknown>> = []
    const browser = {
      tabs: async (opts: Record<string, unknown>) => {
        calls.push(opts)
        return opts.action === 'list' ? { success: true, tabs } : { success: true }
      },
    } as unknown as AgentBrowser

    await closeStrayTabs(browser, '/jobs/view/new')

    const closeIndices = calls.filter((c) => c.action === 'close').map((c) => c.index)
    expect(closeIndices).toEqual([2, 0])
  })
})
