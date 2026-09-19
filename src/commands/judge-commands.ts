import { registerCommand } from './registry.ts'
import { pushLog, setAgentStatus } from '../state/app-state.ts'
import { startScrapeWorker, stopScrapeWorker, isScrapeWorkerRunning } from '../queues/scrape-worker.ts'
import { startJudgeWorker, stopJudgeWorker, isJudgeWorkerRunning } from '../queues/judge-worker.ts'
import { startEasyApplyWorker, stopEasyApplyWorker } from '../queues/easy-apply-worker.ts'
import { isAutoModeOn } from '../agents/search-scheduler.ts'
import { getScrapeQueueCounts } from '../queues/scrape-queues.ts'
import { getJudgeQueueCounts } from '../queues/judge-queues.ts'

const JUDGE_TAB = 'judge'
const STATUS_REFRESH_MS = 2000

let statusInterval: ReturnType<typeof setInterval> | null = null

/** Refreshes each stage's sidebar line with its own queue depth — one interval
 * spanning both workers, but two separate status writes so the scrape and
 * judge tabs never fight over the same line. Best-effort: a transient Redis
 * hiccup just skips a refresh. Exported for direct unit testing. */
export async function updateCombinedStatus(): Promise<void> {
  try {
    const [scrape, judge] = await Promise.all([getScrapeQueueCounts(), getJudgeQueueCounts()])
    setAgentStatus('scrape', 'running', `scrape: ${scrape.waiting} waiting, ${scrape.active} fetching`)
    setAgentStatus(JUDGE_TAB, 'running', `judge: ${judge.waiting} waiting, ${judge.active} judging`)
  } catch {
    // Cosmetic only — ignore.
  }
}

export function registerJudgeCommands(): void {
  registerCommand({
    name: 'process-judge-queue',
    scope: 'judge',
    description: 'Start the scrape, judge, and easy-apply queues for jobs discovered by scan (auto mode owns these while on)',
    run: () => {
      if (isAutoModeOn()) {
        pushLog(JUDGE_TAB, 'Auto mode owns the scrape/judge/apply pipeline while it\'s running — use /auto-off first.')
        return
      }
      if (isScrapeWorkerRunning() || isJudgeWorkerRunning()) {
        pushLog(JUDGE_TAB, 'Judge pipeline is already running. Use /stop-judge-queue first.')
        return
      }
      startScrapeWorker()
      startJudgeWorker()
      // A judge 'easy' match enqueues an apply job that scrape-worker.ts now
      // blocks on — nothing would consume it without this, deadlocking the
      // scrape queue.
      startEasyApplyWorker()
      if (!statusInterval) statusInterval = setInterval(() => void updateCombinedStatus(), STATUS_REFRESH_MS)
      void updateCombinedStatus()
    },
  })

  registerCommand({
    name: 'stop-judge-queue',
    scope: 'judge',
    description: 'Stop the scrape, judge, and easy-apply queues',
    run: async () => {
      if (isAutoModeOn()) {
        pushLog(JUDGE_TAB, 'Auto mode owns the scrape/judge/apply pipeline while it\'s running — use /auto-off first.')
        return
      }
      if (!isScrapeWorkerRunning() && !isJudgeWorkerRunning()) {
        pushLog(JUDGE_TAB, 'Judge pipeline is not running.')
        return
      }
      if (statusInterval) {
        clearInterval(statusInterval)
        statusInterval = null
      }
      await Promise.all([stopScrapeWorker(), stopJudgeWorker(), stopEasyApplyWorker()])
    },
  })
}
