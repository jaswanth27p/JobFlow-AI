import { registerCommand } from './registry.ts'
import { pushLog, setAgentStatus } from '../state/app-state.ts'
import { startScrapeWorker, stopScrapeWorker, isScrapeWorkerRunning } from '../queues/scrape-worker.ts'
import { startJudgeWorker, stopJudgeWorker, isJudgeWorkerRunning } from '../queues/judge-worker.ts'
import { getScrapeQueueCounts } from '../queues/scrape-queues.ts'
import { getJudgeQueueCounts } from '../queues/judge-queues.ts'

const JUDGE_TAB = 'judge'
const STATUS_REFRESH_MS = 2000

let statusInterval: ReturnType<typeof setInterval> | null = null

/** Refreshes the sidebar with both stages' queue depth in one line — a single
 * interval spanning both workers, rather than each writing its own status,
 * so the two don't fight over the sidebar string. Best-effort: a transient
 * Redis hiccup just skips a refresh. */
async function updateCombinedStatus(): Promise<void> {
  try {
    const [scrape, judge] = await Promise.all([getScrapeQueueCounts(), getJudgeQueueCounts()])
    setAgentStatus(JUDGE_TAB, 'running', `scrape: ${scrape.waiting} left, judge: ${judge.waiting} left, ${judge.active} judging`)
  } catch {
    // Cosmetic only — ignore.
  }
}

export function registerJudgeCommands(): void {
  registerCommand({
    name: 'process-judge-queue',
    scope: 'judge',
    description: 'Start the scrape (single browser) and judge (concurrent LLM) queues for jobs discovered by scan',
    run: () => {
      if (isScrapeWorkerRunning() || isJudgeWorkerRunning()) {
        pushLog(JUDGE_TAB, 'Judge pipeline is already running. Use /stop-judge-queue first.')
        return
      }
      startScrapeWorker()
      startJudgeWorker()
      if (!statusInterval) statusInterval = setInterval(() => void updateCombinedStatus(), STATUS_REFRESH_MS)
      void updateCombinedStatus()
    },
  })

  registerCommand({
    name: 'stop-judge-queue',
    scope: 'judge',
    description: 'Stop the scrape and judge queues',
    run: async () => {
      if (!isScrapeWorkerRunning() && !isJudgeWorkerRunning()) {
        pushLog(JUDGE_TAB, 'Judge pipeline is not running.')
        return
      }
      if (statusInterval) {
        clearInterval(statusInterval)
        statusInterval = null
      }
      await Promise.all([stopScrapeWorker(), stopJudgeWorker()])
    },
  })
}
