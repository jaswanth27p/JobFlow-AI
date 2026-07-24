import { describe, test, expect, beforeEach } from 'bun:test'
import { clearRegistryForTest, getCommand } from '../../../src/commands/registry.ts'
import { registerEasyCommands } from '../../../src/commands/easy-commands.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'

beforeEach(() => {
  clearRegistryForTest()
  initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
  registerEasyCommands()
})

describe('easy commands', () => {
  test('registers both easy-tab commands', () => {
    expect(getCommand('process-easy-queue')?.scope).toBe('easy')
    expect(getCommand('stop-easy-queue')?.scope).toBe('easy')
  })

  test('/stop-easy-queue is a no-op with a message when nothing is running', async () => {
    await getCommand('stop-easy-queue')!.run({ args: [], rawArgs: '' })
    expect(appState.tabs.easy.logs).toContain('Easy Apply worker is not running.')
  })
})
