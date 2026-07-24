import { registerCommand } from './registry.ts'
import { pushLog } from '../state/app-state.ts'
import { startEasyApplyWorker, stopEasyApplyWorker, isEasyApplyWorkerRunning } from '../queues/easy-apply-worker.ts'
import { retryAllFailedJobs, setJobStatus, listFailedApplications } from '../queues/retry.ts'
import { openOptionPicker } from '../tui/components/OptionPicker.tsx'
import { getCurrentConfig } from '../config/current.ts'
import { saveAdditionalContext } from '../profile/loader.ts'

const EASY_TAB = 'easy'

/** Shared by /mark-applied and /mark-skipped: when no jobId is given, list
 * currently-failed jobs to pick from instead of making the user go copy a
 * numeric id out of a log line or the dashboard. */
async function openFailedJobPicker(title: string, status: 'applied' | 'skipped'): Promise<void> {
  const failed = await listFailedApplications()
  if (failed.length === 0) {
    pushLog(EASY_TAB, 'No failed applications to mark.')
    return
  }
  openOptionPicker({
    title,
    items: failed.map((f) => ({ label: `${f.title} @ ${f.company}`, value: f.jobId, hint: f.jobId })),
    onConfirm: async (jobId) => {
      const ok = await setJobStatus(jobId, status)
      pushLog(EASY_TAB, ok ? `Marked ${jobId} as ${status}.` : `Job ${jobId} not found.`)
    },
  })
}

export function registerEasyCommands(): void {
  registerCommand({
    name: 'process-easy-queue',
    scope: 'easy',
    description: 'Start processing the Easy Apply queue',
    run: () => {
      if (isEasyApplyWorkerRunning()) {
        pushLog(EASY_TAB, 'Easy Apply worker is already running. Use /stop-easy-queue first.')
        return
      }
      startEasyApplyWorker()
    },
  })

  registerCommand({
    name: 'stop-easy-queue',
    scope: 'easy',
    description: 'Stop processing the Easy Apply queue',
    run: async () => {
      if (!isEasyApplyWorkerRunning()) {
        pushLog(EASY_TAB, 'Easy Apply worker is not running.')
        return
      }
      await stopEasyApplyWorker()
    },
  })

  registerCommand({
    name: 'retry-failed-applications',
    scope: 'easy',
    description: 'Requeue every currently-failed Easy Apply job for another attempt',
    run: async () => {
      const failed = await retryAllFailedJobs()
      if (failed.length === 0) {
        pushLog(EASY_TAB, 'No failed applications to retry.')
        return
      }
      for (const f of failed) {
        pushLog(EASY_TAB, `Requeued: ${f.title} @ ${f.company} (id ${f.jobId})`)
      }
      pushLog(
        EASY_TAB,
        `Requeued ${failed.length} failed application(s).` +
          (isEasyApplyWorkerRunning() ? '' : ' Run /process-easy-queue to start working through them.'),
      )
    },
  })

  registerCommand({
    name: 'add-context',
    scope: 'easy',
    description: '/add-context <text> — add a note the apply agent should know when filling forms (saved to profile.json, picked up by the next job/retry)',
    run: async (ctx) => {
      const note = ctx.rawArgs.trim()
      if (!note) {
        pushLog(EASY_TAB, 'Usage: /add-context <text> — e.g. /add-context I can start immediately, no notice period needed')
        return
      }
      const config = getCurrentConfig()
      await saveAdditionalContext(config.profileFiles.profile, note)
      pushLog(EASY_TAB, `Added context: "${note}" — will apply starting with the next job processed.`)
    },
  })

  registerCommand({
    name: 'mark-applied',
    scope: 'easy',
    description: '/mark-applied <jobId> — manually mark a job applied so it is never retried',
    run: async (ctx) => {
      const jobId = ctx.args[0]
      if (!jobId) {
        await openFailedJobPicker('Mark as applied', 'applied')
        return
      }
      const ok = await setJobStatus(jobId, 'applied')
      pushLog(EASY_TAB, ok ? `Marked ${jobId} as applied.` : `Job ${jobId} not found.`)
    },
  })

  registerCommand({
    name: 'mark-skipped',
    scope: 'easy',
    description: '/mark-skipped <jobId> — manually mark a job skipped/ignored so it is never retried',
    run: async (ctx) => {
      const jobId = ctx.args[0]
      if (!jobId) {
        await openFailedJobPicker('Mark as skipped', 'skipped')
        return
      }
      const ok = await setJobStatus(jobId, 'skipped')
      pushLog(EASY_TAB, ok ? `Marked ${jobId} as skipped.` : `Job ${jobId} not found.`)
    },
  })
}
