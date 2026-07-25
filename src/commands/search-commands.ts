import { registerCommand } from './registry.ts'
import { pushLog } from '../state/app-state.ts'
import { getCurrentConfig } from '../config/current.ts'
import { runSearchUrls, stopSearch, isSearchRunning, type ScanUrlEntry } from '../agents/search-agent.ts'
import { startAutoMode, stopAutoMode, parseDurationMs, type AutoMode } from '../agents/search-scheduler.ts'
import { openOptionPicker } from '../tui/components/OptionPicker.tsx'
import type { AppConfig } from '../config/schema.ts'

type UrlGroup = AppConfig['urlGroups'][number]

/** Preset choices for the /auto-on interval duration picker — covers the
 * common cases; anything else still works by typing /auto-on interval <duration> directly. */
const INTERVAL_PRESETS = ['30m', '1h', '2h', '3h', '6h', '12h', '24h']

const SEARCH_TAB = 'search'

function flattenGroup(group: UrlGroup): ScanUrlEntry[] {
  return group.urls.map((u) => ({ url: u.url, scanFullList: u.scanFullList }))
}

/** Shared by /search-urls and /auto-on's final step — lets the user pick one
 * configured urlGroups entry, or "All groups" to run every group's URLs back
 * to back. Always shown, even when only one group is configured. */
function openGroupPicker(urlGroups: UrlGroup[], onConfirm: (entries: ScanUrlEntry[], label: string) => void): void {
  if (urlGroups.length === 0) {
    pushLog(SEARCH_TAB, 'No URL groups configured — add one to urlGroups in linkedin-auto.config.ts.')
    return
  }
  const totalUrls = urlGroups.reduce((n, g) => n + g.urls.length, 0)
  openOptionPicker({
    title: 'Which group?',
    items: [
      ...urlGroups.map((g) => ({ label: g.name, value: g.name, hint: `${g.urls.length} url(s)` })),
      { label: 'All groups', value: '__all__', hint: `${totalUrls} url(s) total` },
    ],
    onConfirm: (value) => {
      if (value === '__all__') {
        onConfirm(urlGroups.flatMap(flattenGroup), 'All groups')
        return
      }
      const group = urlGroups.find((g) => g.name === value)
      if (group) onConfirm(flattenGroup(group), group.name)
    },
  })
}

/** Final step of every /auto-on path (typed args or pickers): pick a group,
 * then actually start the scheduler with it. */
function beginAutoMode(mode: AutoMode, intervalMs?: number): void {
  const config = getCurrentConfig()
  openGroupPicker(config.urlGroups, (entries, groupLabel) => {
    startAutoMode(mode, entries, groupLabel, intervalMs)
  })
}

function openIntervalDurationPicker(): void {
  openOptionPicker({
    title: 'Repeat every...',
    items: INTERVAL_PRESETS.map((d) => ({ label: d, value: d })),
    onConfirm: (durationRaw) => {
      const ms = parseDurationMs(durationRaw)
      if (ms === null) {
        pushLog(SEARCH_TAB, `Invalid duration: ${durationRaw}.`)
        return
      }
      beginAutoMode('interval', ms)
    },
  })
}

function guardNotRunning(): boolean {
  if (isSearchRunning()) {
    pushLog(SEARCH_TAB, 'A search is already running. Use /stop-search first.')
    return false
  }
  return true
}

export function registerSearchCommands(): void {
  registerCommand({
    name: 'search-urls',
    scope: 'search',
    description: 'Run configured LinkedIn search URLs (picks a group first)',
    run: () => {
      if (!guardNotRunning()) return
      const config = getCurrentConfig()
      openGroupPicker(config.urlGroups, (entries) => {
        void runSearchUrls(entries)
      })
    },
  })

  registerCommand({
    name: 'stop-search',
    scope: 'search',
    description: 'Stop the in-progress search run',
    run: () => {
      if (!isSearchRunning()) {
        pushLog(SEARCH_TAB, 'No search is running.')
        return
      }
      stopSearch()
      pushLog(SEARCH_TAB, 'Stopping search...')
    },
  })

  registerCommand({
    name: 'auto-on',
    scope: 'search',
    description:
      '/auto-on loop | /auto-on interval <duration> (e.g. 1h, 3h, 90m) — repeatedly run a configured search URL group (picker), and start the easy-apply queue worker',
    run: (ctx) => {
      const mode = ctx.args[0]
      if (mode === 'loop') {
        beginAutoMode('loop')
        return
      }
      if (mode === 'interval') {
        const durationRaw = ctx.args[1]
        if (!durationRaw) {
          openIntervalDurationPicker()
          return
        }
        const ms = parseDurationMs(durationRaw)
        if (ms === null) {
          pushLog(SEARCH_TAB, `Invalid duration: ${durationRaw}. Use formats like 1h, 3h, 90m, 3h30m.`)
          return
        }
        beginAutoMode('interval', ms)
        return
      }
      if (mode) {
        // A mode WAS given, just not one we recognize — a picker would be
        // confusing here (it'd silently discard what they typed); tell them.
        pushLog(SEARCH_TAB, 'Usage: /auto-on loop | /auto-on interval <duration>')
        return
      }
      // No arguments at all — let the user pick loop vs. interval instead of
      // just printing a usage line.
      openOptionPicker({
        title: 'Auto mode',
        items: [
          { label: 'Loop', value: 'loop', hint: 'run continuously, cooldown between cycles' },
          { label: 'Interval', value: 'interval', hint: 'repeat on a fixed schedule' },
        ],
        onConfirm: (value) => {
          if (value === 'loop') {
            beginAutoMode('loop')
          } else {
            openIntervalDurationPicker()
          }
        },
      })
    },
  })

  registerCommand({
    name: 'auto-off',
    scope: 'search',
    description: 'Stop the auto-mode search rotation (the easy-apply queue worker keeps running)',
    run: () => stopAutoMode(),
  })
}
