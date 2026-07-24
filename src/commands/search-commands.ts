import { registerCommand } from './registry.ts'
import { pushLog } from '../state/app-state.ts'
import { getCurrentConfig } from '../config/current.ts'
import { runSearchUrls, stopSearch, isSearchRunning } from '../agents/search-agent.ts'
import { startAutoMode, stopAutoMode, parseDurationMs } from '../agents/search-scheduler.ts'
import { openOptionPicker } from '../tui/components/OptionPicker.tsx'

/** Preset choices for the /auto-on interval duration picker — covers the
 * common cases; anything else still works by typing /auto-on interval <duration> directly. */
const INTERVAL_PRESETS = ['30m', '1h', '2h', '3h', '6h', '12h', '24h']

const SEARCH_TAB = 'search'

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
      startAutoMode('interval', ms)
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
    description: 'Run configured LinkedIn search URLs',
    run: async () => {
      if (!guardNotRunning()) return
      const config = getCurrentConfig()
      await runSearchUrls(config.mustCheckUrls)
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
      '/auto-on loop | /auto-on interval <duration> (e.g. 1h, 3h, 90m) — repeatedly run the configured search URLs, and start the easy-apply queue worker',
    run: (ctx) => {
      const mode = ctx.args[0]
      if (mode === 'loop') {
        startAutoMode('loop')
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
        startAutoMode('interval', ms)
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
            startAutoMode('loop')
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
