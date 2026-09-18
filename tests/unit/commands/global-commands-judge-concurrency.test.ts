import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { clearRegistryForTest, getCommand } from '../../../src/commands/registry.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'

// /set judgeConcurrency must (a) validate 1-10 and (b) restart a running
// judge worker with the new size. The judge worker itself is mocked — this
// test is about the command's wiring.
const startCalls: number[] = []
let running = false

mock.module('../../../src/queues/judge-worker.ts', () => ({
  startJudgeWorker: (n?: number) => {
    startCalls.push(n ?? -1)
    running = true
  },
  stopJudgeWorker: async () => {
    running = false
  },
  isJudgeWorkerRunning: () => running,
}))

const globalSpecifier = '../../../src/commands/global-commands.ts?__set_test'
const { registerGlobalCommands } = await import(globalSpecifier)

// Restore the real judge-worker module — a partial mock left registered would
// leak into later test files (Bun's mock.module is process-global), same as
// judge-worker.test.ts's afterAll restore.
afterAll(async () => {
  const judgeWorkerSpecifier = '../../../src/queues/judge-worker.ts?__restore_set_judge_concurrency_test'
  const judgeWorkerReal = await import(judgeWorkerSpecifier)
  mock.module('../../../src/queues/judge-worker.ts', () => ({ ...judgeWorkerReal }))
})

function runSet(key: string, value: string): Promise<void> | void {
  return getCommand('set')!.run({ args: [key, value], rawArgs: `${key} ${value}` })
}

beforeEach(() => {
  clearRegistryForTest()
  initAppState({ concurrency: 1, judgeConcurrency: 3, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
  startCalls.length = 0
  running = false
  registerGlobalCommands()
})

describe('/set judgeConcurrency', () => {
  test('updates the live setting and restarts a running judge worker at the new size', async () => {
    running = true
    await runSet('judgeConcurrency', '5')
    expect(appState.settings.judgeConcurrency).toBe(5)
    expect(startCalls).toEqual([5])
  })

  test('updates the setting without restarting when the judge worker is idle', async () => {
    await runSet('judgeConcurrency', '4')
    expect(appState.settings.judgeConcurrency).toBe(4)
    expect(startCalls).toEqual([])
  })

  test('rejects values outside 1-10 without changing the setting', async () => {
    running = true
    await runSet('judgeConcurrency', '11')
    expect(appState.settings.judgeConcurrency).toBe(3)
    await runSet('judgeConcurrency', '0')
    expect(appState.settings.judgeConcurrency).toBe(3)
    expect(startCalls).toEqual([])
  })

  test('rejects non-integer values', async () => {
    await runSet('judgeConcurrency', '2.5')
    expect(appState.settings.judgeConcurrency).toBe(3)
  })
})
