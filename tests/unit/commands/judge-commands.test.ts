import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { clearRegistryForTest, getCommand } from '../../../src/commands/registry.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'

const calls: string[] = []
let scrapeRunning = false
let judgeRunning = false
let easyRunning = false
let autoModeOn = false

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
mock.module('../../../src/queues/easy-apply-worker.ts', () => ({
  startEasyApplyWorker: () => { calls.push('startEasyApply'); easyRunning = true },
  stopEasyApplyWorker: async () => { calls.push('stopEasyApply'); easyRunning = false },
  isEasyApplyWorkerRunning: () => easyRunning,
}))
// judge-commands.ts now imports isAutoModeOn to guard the manual commands
// while auto mode owns the pipeline — mocked so this file doesn't pull the
// whole scheduler/browser stack in (and so the guard can be toggled per test).
mock.module('../../../src/agents/search-scheduler.ts', () => ({
  isAutoModeOn: () => autoModeOn,
  startAutoMode: () => {},
  stopAutoMode: () => {},
  stopAutoModeAndWait: async () => {},
  parseDurationMs: () => null,
  formatDuration: () => '',
  nextCycleWaitMs: (elapsedMs: number, durationMs: number) => Math.max(0, durationMs - elapsedMs),
}))
mock.module('../../../src/queues/scrape-queues.ts', () => ({
  getScrapeQueueCounts: async () => ({ waiting: 0, active: 0, delayed: 0 }),
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
  initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000 })
  calls.length = 0
  scrapeRunning = false
  judgeRunning = false
  easyRunning = false
  autoModeOn = false
  registerJudgeCommands()
})

describe('/process-judge-queue', () => {
  test('starts the scrape, judge, and easy-apply workers', async () => {
    await getCommand('process-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).toEqual(expect.arrayContaining(['startScrape', 'startJudge', 'startEasyApply']))
  })

  test('is a no-op when already running', async () => {
    scrapeRunning = true
    await getCommand('process-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).not.toContain('startScrape')
  })

  test('refuses while auto mode owns the pipeline', async () => {
    autoModeOn = true
    await getCommand('process-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).not.toContain('startScrape')
    expect(calls).not.toContain('startJudge')
    expect(calls).not.toContain('startEasyApply')
    expect(appState.tabs.judge.logs.some((l) => l.includes('Auto mode owns'))).toBe(true)
  })
})

describe('/stop-judge-queue', () => {
  test('stops the scrape, judge, and easy-apply workers', async () => {
    scrapeRunning = true
    judgeRunning = true
    easyRunning = true
    await getCommand('stop-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).toEqual(expect.arrayContaining(['stopScrape', 'stopJudge', 'stopEasyApply']))
  })

  test('is a no-op when nothing is running', async () => {
    await getCommand('stop-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).not.toContain('stopScrape')
    expect(calls).not.toContain('stopJudge')
  })

  test('refuses while auto mode owns the pipeline', async () => {
    autoModeOn = true
    scrapeRunning = true
    judgeRunning = true
    await getCommand('stop-judge-queue')!.run({ args: [], rawArgs: '' })
    expect(calls).not.toContain('stopScrape')
    expect(calls).not.toContain('stopJudge')
    expect(calls).not.toContain('stopEasyApply')
    expect(appState.tabs.judge.logs.some((l) => l.includes('Auto mode owns'))).toBe(true)
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

// Bun's mock.module is process-global and leaks into later test files. The
// search-scheduler stub above is partial (it only needs isAutoModeOn), and
// leaking it would break search-commands.test.ts (its /auto-off no-op and
// duration parsing both depend on the real scheduler) — restore the real
// module afterward, same pattern as judge-worker.test.ts.
afterAll(async () => {
  const schedulerSpecifier = '../../../src/agents/search-scheduler.ts?__restore_real_judge_commands_test'
  const schedulerReal = await import(schedulerSpecifier)
  mock.module('../../../src/agents/search-scheduler.ts', () => ({ ...schedulerReal }))
})
