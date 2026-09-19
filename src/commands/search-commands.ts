import { registerCommand } from './registry.ts'
import { pushLog } from '../state/app-state.ts'
import { getCurrentConfig } from '../config/current.ts'
import { runSearchUrls, stopSearch, isSearchRunning, type ScanUrlEntry } from '../agents/search-agent.ts'
import { startAutoMode, stopAutoMode, parseDurationMs } from '../agents/search-scheduler.ts'
import { openOptionPicker } from '../tui/components/OptionPicker.tsx'
import type { AppConfig } from '../config/schema.ts'

type UrlGroup = AppConfig['urlGroups'][number]

/** Preset choices for the /auto-on duration picker — covers the common
 * cases; anything else still works by typing /auto-on <duration> directly. */
const DURATION_PRESETS = ['30m', '1h', '2h', '3h', '6h', '12h', '24h']

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

/** Final step of /auto-on (typed duration or picker): pick a group, then
 * actually start the scheduler with it. */
function beginAutoMode(durationMs: number): void {
  const config = getCurrentConfig()
  openGroupPicker(config.urlGroups, (entries, groupLabel) => {
    startAutoMode(entries, groupLabel, durationMs)
  })
}

function openDurationPicker(): void {
  openOptionPicker({
    title: 'Target cycle duration...',
    items: DURATION_PRESETS.map((d) => ({ label: d, value: d })),
    onConfirm: (durationRaw) => {
      const ms = parseDurationMs(durationRaw)
      if (ms === null) {
        pushLog(SEARCH_TAB, `Invalid duration: ${durationRaw}.`)
        return
      }
      beginAutoMode(ms)
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
      '/auto-on <duration> (e.g. 1h, 3h, 90m) — pick a configured search URL group (picker), then repeatedly run a full search-then-apply cycle targeting one cycle every <duration>',
    run: (ctx) => {
      const durationRaw = ctx.args[0]
      if (!durationRaw) {
        openDurationPicker()
        return
      }
      const ms = parseDurationMs(durationRaw)
      if (ms === null) {
        pushLog(SEARCH_TAB, `Invalid duration: ${durationRaw}. Use formats like 1h, 3h, 90m, 3h30m.`)
        return
      }
      beginAutoMode(ms)
    },
  })

  registerCommand({
    name: 'auto-off',
    scope: 'search',
    description: 'Stop the auto-mode rotation (the current cycle, and its easy-apply/judge workers, keep running to completion)',
    run: () => stopAutoMode(),
  })
}
