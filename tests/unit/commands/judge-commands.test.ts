import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { clearRegistryForTest, getCommand } from '../../../src/commands/registry.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'

const calls: string[] = []
let scrapeRunning = false
let judgeRunning = false

// These mocks are process-global (Bun's mock.module has no per-file scope), so
// each one covers EVERY export of its module. A partial mock omitting an export
// that a later import needs throws "Export named X not found" — including from
// a fresh scrape-worker import, whose bare judge-queues dependency would then
// resolve to a partial judge-queues mock. Complete stubs make that impossible.
mock.module('../../../src/queues/scrape-worker.ts', () => ({
  startScrapeWorker: () => { calls.push('startScrape'); scrapeRunning = true },
  stopScrapeWorker: async () => { calls.push('stopScrape'); scrapeRunning = false },
  isScrapeWorkerRunning: () => scrapeRunning,
  processScrapeJob: async () => {},
}))
mock.module('../../../src/queues/judge-worker.ts', () => ({
  startJudgeWorker: () => { calls.push('startJudge'); judgeRunning = true },
  stopJudgeWorker: async () => { calls.push('stopJudge'); judgeRunning = false },
  isJudgeWorkerRunning: () => judgeRunning,
  processJudgeJob: async () => {},
  recordJudgeVerdict: async () => {},
}))
mock.module('../../../src/queues/scrape-queues.ts', () => ({
  getScrapeQueueCounts: async () => ({ waiting: 0, active: 0 }),
  enqueueScrapeJob: async () => {},
  closeScrapeQueues: async () => {},
}))
mock.module('../../../src/queues/judge-queues.ts', () => ({
  getJudgeQueueCounts: async () => ({ waiting: 0, active: 0 }),
  enqueueJudgeJob: async () => {},
  closeJudgeQueues: async () => {},
}))

const specifier = '../../../src/commands/judge-commands.ts?__judge_commands_test'
const { registerJudgeCommands } = await import(specifier)

beforeEach(() => {
  clearRegistryForTest()
  initAppState({ concurrency: 1, judgeConcurrency: 3, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
  calls.length = 0
  scrapeRunning = false
  judgeRunning = false
  registerJudgeCommands()
})

describe('/process-judge-queue', () => {
  test('starts both the scrape and judge workers', async () => {
    await getCommand('process-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).toEqual(expect.arrayContaining(['startScrape', 'startJudge']))
  })

  test('is a no-op when already running', async () => {
    scrapeRunning = true
    await getCommand('process-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).not.toContain('startScrape')
  })
})

describe('/stop-judge-queue', () => {
  test('stops both workers', async () => {
    scrapeRunning = true
    judgeRunning = true
    await getCommand('stop-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).toEqual(expect.arrayContaining(['stopScrape', 'stopJudge']))
  })

  test('is a no-op when nothing is running', async () => {
    await getCommand('stop-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).not.toContain('stopScrape')
    expect(calls).not.toContain('stopJudge')
  })
})

describe('updateCombinedStatus', () => {
  test('writes scrape depth to the scrape tab and judge depth to the judge tab', async () => {
    const { updateCombinedStatus } = await import(specifier)
    await updateCombinedStatus()
    expect(appState.tabs.scrape.step).toContain('scrape:')
    expect(appState.tabs.judge.step).toContain('judge:')
  })
})
