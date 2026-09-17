import { describe, test, expect } from 'bun:test'
import { navigateOwnTab, isBrowserConnectionError } from '../../../src/browser/tab-guard.ts'
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
