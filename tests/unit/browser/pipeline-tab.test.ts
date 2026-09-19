import { describe, test, expect, mock, beforeEach } from 'bun:test'

const calls: string[] = []
let nextNavigateThrows: Error | null = null

mock.module('../../../src/browser/session.ts', () => ({
  getSharedCdpUrl: () => 'ws://fake-cdp',
}))
mock.module('../../../src/browser/tab-guard.ts', () => ({
  openOwnTab: async (_browser: unknown, _cdpUrl: string, url: string, matchFragment: string) => {
    calls.push(`open:${url}:${matchFragment}`)
    return { matchFragment }
  },
  navigateOwnTab: async (_browser: unknown, _cdpUrl: string, tab: { matchFragment: string }, url: string, matchFragment: string) => {
    calls.push(`navigate:${tab.matchFragment}->${url}:${matchFragment}`)
    if (nextNavigateThrows) {
      const err = nextNavigateThrows
      nextNavigateThrows = null
      throw err
    }
    return { matchFragment }
  },
  closeOwnTab: async (_browser: unknown, tab: { matchFragment: string }) => {
    calls.push(`close:${tab.matchFragment}`)
  },
  isBrowserConnectionError: () => false,
  isOwnedTabGoneError: (err: unknown) => err instanceof Error && err.message.includes('no longer exists'),
}))

beforeEach(() => {
  calls.length = 0
  nextNavigateThrows = null
})

describe('pipeline-tab', () => {
  test('opens a fresh tab the first time, then navigates the SAME tab in place on later calls', async () => {
    const specifier = '../../../src/browser/pipeline-tab.ts?__pipeline_tab_test_reuse'
    const { ensurePipelineTab } = await import(specifier)

    await ensurePipelineTab('https://example.com/search', '/jobs/search')
    await ensurePipelineTab('https://example.com/jobs/view/1', '/jobs/view/1')

    expect(calls[0]).toBe('open:https://example.com/search:/jobs/search')
    expect(calls[1]).toBe('navigate:/jobs/search->https://example.com/jobs/view/1:/jobs/view/1')
  })

  test('falls back to opening a fresh tab when the cached one is gone', async () => {
    const specifier = '../../../src/browser/pipeline-tab.ts?__pipeline_tab_test_gone'
    const { ensurePipelineTab } = await import(specifier)

    await ensurePipelineTab('https://example.com/search', '/jobs/search')
    nextNavigateThrows = new Error('Owned tab (matched "/jobs/search") no longer exists — cannot reuse it.')
    await ensurePipelineTab('https://example.com/jobs/view/2', '/jobs/view/2')

    expect(calls).toEqual([
      'open:https://example.com/search:/jobs/search',
      'navigate:/jobs/search->https://example.com/jobs/view/2:/jobs/view/2',
      'open:https://example.com/jobs/view/2:/jobs/view/2',
    ])
  })
})
