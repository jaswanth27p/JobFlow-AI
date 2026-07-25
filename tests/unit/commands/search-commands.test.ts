import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { clearRegistryForTest, getCommand } from '../../../src/commands/registry.ts'
import { registerSearchCommands } from '../../../src/commands/search-commands.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'
import { setCurrentConfig } from '../../../src/config/current.ts'
import { optionPickerOpen, closeOptionPicker } from '../../../src/tui/components/OptionPicker.tsx'
import type { AppConfig } from '../../../src/config/schema.ts'

function makeConfig(): AppConfig {
  return {
    urlGroups: [],
    requirements: 'placeholder',
    concurrency: 1,
    model: 'test',
    models: {},
    notifySummaryIntervalMinutes: 30,
    profileFiles: { resume: './resume.md', profile: './profile.json' },
    extraPrompts: { search: '', easyApply: '' },
    search: { minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 },
  }
}

beforeEach(() => {
  clearRegistryForTest()
  initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
  setCurrentConfig(makeConfig())
  registerSearchCommands()
})

// OptionPicker's open/selected state is a module-level signal (like the theme
// and tab pickers) — it survives across test files in the same bun test
// process, so a picker left open here would swallow keystrokes in unrelated
// TUI tests that run later. Always close it.
afterEach(() => {
  closeOptionPicker()
})

describe('search commands', () => {
  test('registers the four search-tab commands', () => {
    expect(getCommand('search-urls')?.scope).toBe('search')
    expect(getCommand('stop-search')?.scope).toBe('search')
    expect(getCommand('auto-on')?.scope).toBe('search')
    expect(getCommand('auto-off')?.scope).toBe('search')
  })

  test('no longer registers search-describe or search-resume', () => {
    expect(getCommand('search-describe')).toBeUndefined()
    expect(getCommand('search-resume')).toBeUndefined()
  })

  test('/stop-search is a no-op with a message when nothing is running', async () => {
    await getCommand('stop-search')!.run({ args: [], rawArgs: '' })
    expect(appState.tabs.search.logs).toContain('No search is running.')
  })

  test('/auto-off is a no-op with a message when auto mode is not on', async () => {
    await getCommand('auto-off')!.run({ args: [], rawArgs: '' })
    expect(appState.tabs.search.logs).toContain('Auto mode is not on.')
  })

  test('/auto-on with no mode arg opens the mode picker instead of starting anything', async () => {
    await getCommand('auto-on')!.run({ args: [], rawArgs: '' })
    expect(optionPickerOpen()).toBe(true)
  })

  test('/auto-on with an unrecognized mode logs usage', async () => {
    await getCommand('auto-on')!.run({ args: ['bogus'], rawArgs: 'bogus' })
    expect(appState.tabs.search.logs).toContain('Usage: /auto-on loop | /auto-on interval <duration>')
  })

  test('/auto-on interval with no duration opens the duration picker', async () => {
    await getCommand('auto-on')!.run({ args: ['interval'], rawArgs: 'interval' })
    expect(optionPickerOpen()).toBe(true)
  })

  test('/auto-on interval with an invalid duration logs a rejection', async () => {
    await getCommand('auto-on')!.run({ args: ['interval', 'not-a-duration'], rawArgs: 'interval not-a-duration' })
    expect(appState.tabs.search.logs).toContain(
      'Invalid duration: not-a-duration. Use formats like 1h, 3h, 90m, 3h30m.',
    )
  })

  test('/search-urls with no groups configured logs a message instead of opening a picker', async () => {
    await getCommand('search-urls')!.run({ args: [], rawArgs: '' })
    expect(appState.tabs.search.logs).toContain(
      'No URL groups configured — add one to urlGroups in linkedin-auto.config.ts.',
    )
    expect(optionPickerOpen()).toBe(false)
  })

  test('/search-urls with groups configured opens the group picker', async () => {
    setCurrentConfig({
      ...makeConfig(),
      urlGroups: [{ name: 'Hyderabad', urls: [{ url: 'https://example.com', scanFullList: false }] }],
    })
    await getCommand('search-urls')!.run({ args: [], rawArgs: '' })
    expect(optionPickerOpen()).toBe(true)
  })

  test('/auto-on loop opens the group picker as its final step', async () => {
    setCurrentConfig({
      ...makeConfig(),
      urlGroups: [{ name: 'Hyderabad', urls: [{ url: 'https://example.com', scanFullList: false }] }],
    })
    await getCommand('auto-on')!.run({ args: ['loop'], rawArgs: 'loop' })
    expect(optionPickerOpen()).toBe(true)
  })
})
