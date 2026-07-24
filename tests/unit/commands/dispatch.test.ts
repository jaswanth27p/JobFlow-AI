import { describe, test, expect, beforeEach } from 'bun:test'
import { clearRegistryForTest, registerCommand } from '../../../src/commands/registry.ts'
import { dispatchCommand } from '../../../src/commands/dispatch.ts'
import { initAppState, appState, setSessionStatus, pushLog } from '../../../src/state/app-state.ts'

beforeEach(() => {
  clearRegistryForTest()
  initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
  registerCommand({ name: 'help', scope: 'global', description: '', run: () => {} })
  registerCommand({
    name: 'search-urls',
    scope: 'search',
    description: '',
    // Uses the real pushLog API rather than mutating the Solid store's array
    // directly — direct .push() on a store-derived array doesn't persist
    // through Solid's store proxy (confirmed while validating this plan).
    run: () => {
      pushLog('search', 'ran')
    },
  })
})

describe('dispatchCommand', () => {
  test('runs global commands before login is verified', async () => {
    await expect(dispatchCommand('/help')).resolves.toBeUndefined()
  })

  test('rejects tab-scoped commands before login is verified', async () => {
    await dispatchCommand('/search-urls')
    expect(appState.tabs.search.logs.some((l) => l.includes('log in') || l.includes('verify-login'))).toBe(true)
    expect(appState.tabs.search.logs).not.toContain('ran')
  })

  test('allows tab-scoped commands once linkedin is connected', async () => {
    setSessionStatus('linkedin', true)
    await dispatchCommand('/search-urls')
    expect(appState.tabs.search.logs).toContain('ran')
  })

  test('unknown command logs an error to the active tab', async () => {
    await dispatchCommand('/nonexistent')
    expect(appState.tabs.search.logs.some((l) => l.includes('Unknown command'))).toBe(true)
  })
})
