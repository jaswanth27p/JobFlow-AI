import notifier from 'node-notifier'
import open from 'open'
import { logger } from '../utils/logger.ts'
import type { TabId } from '../state/types.ts'

export type NotifyEvent =
  | { kind: 'external-job-found'; title: string; company: string; applyUrl: string }
  | { kind: 'needs-input'; tab: TabId; question: string }
  | { kind: 'easy-apply-result'; success: boolean; title: string; company: string; error?: string }
  | { kind: 'summary'; easyApplied: number; easyFailed: number; externalFound: number; intervalMinutes: number }

export interface BuiltNotification {
  title: string
  message: string
  openUrl?: string
}

const TAB_LABELS: Record<TabId, string> = {
  search: 'Search',
  easy: 'Easy Apply',
  judge: 'Judge Queue',
  careers: 'Career Pages',
}

/** Pure — shapes the title/message/click-target for each event kind. No I/O,
 * so this is the unit-tested surface; notify() itself is a thin, best-effort
 * side-effecting wrapper around it. */
export function buildNotification(event: NotifyEvent): BuiltNotification {
  switch (event.kind) {
    case 'external-job-found':
      return {
        title: `External job: ${event.title} @ ${event.company}`,
        message: event.applyUrl,
        openUrl: event.applyUrl,
      }
    case 'needs-input':
      return {
        title: `${TAB_LABELS[event.tab]} needs your input`,
        message: event.question,
      }
    case 'easy-apply-result':
      return {
        title: event.success ? 'Applied' : 'Application failed',
        message: event.success
          ? `${event.title} @ ${event.company}`
          : `${event.title} @ ${event.company} — ${event.error ?? 'unknown error'}`,
      }
    case 'summary':
      return {
        title: `Summary (last ${event.intervalMinutes}m)`,
        message: `Easy Apply: ${event.easyApplied} applied, ${event.easyFailed} failed\nExternal jobs found: ${event.externalFound}`,
      }
  }
}

/** Fires an OS desktop notification for the given event. Best-effort only —
 * a missing/broken OS notification backend (no daemon, permissions denied,
 * etc.) must never crash an agent run, so every failure path here is caught
 * and logged, never thrown. */
export function notify(event: NotifyEvent): void {
  const built = buildNotification(event)
  try {
    notifier.notify({ title: built.title, message: built.message, sound: false, wait: false }, (err) => {
      if (err) logger.error({ err, event }, 'notify: node-notifier reported an error')
    })
    // Best-effort click-to-open: registers a one-shot listener per notification.
    // node-notifier's 'click' event is global (not scoped per notify() call) and
    // listeners stack — under multiple pending external-job notifications, one
    // click fires every still-registered listener, opening all of their URLs at
    // once, not just the clicked one. Acceptable here given external-job
    // notifications are infrequent in practice.
    if (built.openUrl && /^https?:\/\//i.test(built.openUrl)) {
      const url = built.openUrl
      notifier.once('click', () => {
        void open(url).catch((err) => logger.error({ err, url }, 'notify: failed to open URL'))
      })
    }
  } catch (err) {
    logger.error({ err, event }, 'notify: failed to send notification')
  }
}
