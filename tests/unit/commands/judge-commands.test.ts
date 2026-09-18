import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { clearRegistryForTest, getCommand } from '../../../src/commands/registry.ts'
import { initAppState } from '../../../src/state/app-state.ts'

const calls: string[] = []
let scrapeRunning = false
let judgeRunning = false

mock.module('../../../src/queues/scrape-worker.ts', () => ({
  startScrapeWorker: () => { calls.push('startScrape'); scrapeRunning = true },
  stopScrapeWorker: async () => { calls.push('stopScrape'); scrapeRunning = false },
  isScrapeWorkerRunning: () => scrapeRunning,
}))
mock.module('../../../src/queues/judge-worker.ts', () => ({
  startJudgeWorker: () => { calls.push('startJudge'); judgeRunning = true },
  stopJudgeWorker: async () => { calls.push('stopJudge'); judgeRunning = false },
  isJudgeWorkerRunning: () => judgeRunning,
}))
mock.module('../../../src/queues/scrape-queues.ts', () => ({
  getScrapeQueueCounts: async () => ({ waiting: 0, active: 0 }),
}))
mock.module('../../../src/queues/judge-queues.ts', () => ({
  getJudgeQueueCounts: async () => ({ waiting: 0, active: 0 }),
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
