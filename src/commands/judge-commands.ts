import { registerCommand } from './registry.ts'
import { pushLog } from '../state/app-state.ts'
import { startJudgeWorker, stopJudgeWorker, isJudgeWorkerRunning } from '../queues/judge-worker.ts'

const JUDGE_TAB = 'judge'

export function registerJudgeCommands(): void {
  registerCommand({
    name: 'process-judge-queue',
    scope: 'judge',
    description: 'Start processing the judge queue (jobs discovered by scan, awaiting relevance judgment)',
    run: () => {
      if (isJudgeWorkerRunning()) {
        pushLog(JUDGE_TAB, 'Judge queue worker is already running. Use /stop-judge-queue first.')
        return
      }
      startJudgeWorker()
    },
  })

  registerCommand({
    name: 'stop-judge-queue',
    scope: 'judge',
    description: 'Stop processing the judge queue',
    run: async () => {
      if (!isJudgeWorkerRunning()) {
        pushLog(JUDGE_TAB, 'Judge queue worker is not running.')
        return
      }
      await stopJudgeWorker()
    },
  })
}
