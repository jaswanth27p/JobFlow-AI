import { registerCommand } from './registry.ts'
import { listCommandsForTab } from './registry.ts'
import { appState, setSessionStatus, setActiveTab, setSetting, pushLog, TAB_IDS } from '../state/app-state.ts'
import type { TabId, Settings } from '../state/types.ts'
import { getBrowserServerPort } from '../browser/session.ts'
import { verifyLogin } from '../browser/verify-login.ts'
import { openTabPicker } from '../tui/components/TabPicker.tsx'
import { openThemePicker } from '../tui/components/ThemePicker.tsx'
import { openOptionPicker } from '../tui/components/OptionPicker.tsx'
import { prefillInput } from '../tui/components/InputBar.tsx'
import { setTheme } from '../tui/theme/current.ts'
import { hasTheme } from '../tui/theme/index.ts'
import { persistThemeName } from '../tui/theme/persist.ts'

export function registerGlobalCommands(): void {
  registerCommand({
    name: 'help',
    scope: 'global',
    description: 'List available commands for the active tab',
    run: () => {
      const list = listCommandsForTab(appState.activeTab)
      pushLog(appState.activeTab, `Commands: ${list.map((c) => '/' + c.name).join(', ')}`)
    },
  })

  registerCommand({
    name: 'tab',
    scope: 'global',
    description: '/tab [search|easy|external|careers] — switch tab (no arg opens a picker)',
    run: (ctx) => {
      const target = ctx.args[0] as TabId | undefined
      // No argument → open the centered picker dialog.
      if (!target) {
        openTabPicker()
        return
      }
      if (!TAB_IDS.includes(target)) {
        pushLog(appState.activeTab, `Usage: /tab ${TAB_IDS.join('|')}`)
        return
      }
      setActiveTab(target)
    },
  })

  registerCommand({
    name: 'theme',
    scope: 'global',
    description: '/theme [name] — switch color theme (no arg opens a picker)',
    run: (ctx) => {
      const target = ctx.args[0]
      if (!target) {
        openThemePicker()
        return
      }
      if (!hasTheme(target)) {
        pushLog(appState.activeTab, `Unknown theme: ${target}. Run /theme with no args to browse.`)
        return
      }
      setTheme(target)
      persistThemeName(target)
      pushLog(appState.activeTab, `Theme changed to: ${target}`)
    },
  })

  registerCommand({
    name: 'set',
    scope: 'global',
    description: '/set <concurrency|model|minNavDelayMs|maxNavDelayMs|loopCooldownMs> <value>',
    run: (ctx) => {
      const [key, ...rest] = ctx.args
      const value = rest.join(' ')

      // No key given at all — let the user pick which setting instead of
      // just printing a usage line. The value still isn't a bounded set of
      // options, so hand off to the input bar prefilled with "/set <key> "
      // for them to type it, rather than a second picker.
      if (!key) {
        openOptionPicker({
          title: 'Change a setting',
          items: [
            { label: 'concurrency', value: 'concurrency', hint: 'parallel easy-apply jobs' },
            { label: 'model', value: 'model', hint: 'LLM model id' },
            { label: 'minNavDelayMs', value: 'minNavDelayMs', hint: 'min pause after navigation' },
            { label: 'maxNavDelayMs', value: 'maxNavDelayMs', hint: 'max pause after navigation' },
            { label: 'loopCooldownMs', value: 'loopCooldownMs', hint: 'pause between /auto-on loop cycles' },
          ],
          onConfirm: (chosenKey) => prefillInput(`/set ${chosenKey} `),
        })
        return
      }

      // Every numeric setting is validated here — an unchecked Number() let
      // `/set concurrency abc` poison the live settings with NaN.
      const numericRules: Partial<Record<keyof Settings, { min: number; integer: boolean; max?: number }>> = {
        concurrency: { min: 1, integer: true },
        minNavDelayMs: { min: 0, integer: true },
        maxNavDelayMs: { min: 0, integer: true },
        loopCooldownMs: { min: 60_000, integer: true },
      }

      if (key === 'model') {
        if (!value.trim()) {
          pushLog(appState.activeTab, 'Usage: /set model <model-id>')
          return
        }
        setSetting('model', value.trim())
      } else if (key && key in numericRules) {
        const rule = numericRules[key as keyof Settings]!
        const num = Number(value)
        if (
          !value.trim() ||
          !Number.isFinite(num) ||
          num < rule.min ||
          (rule.max !== undefined && num > rule.max) ||
          (rule.integer && !Number.isInteger(num))
        ) {
          const range = rule.max !== undefined ? `${rule.min}-${rule.max}` : `>= ${rule.min}`
          pushLog(appState.activeTab, `Invalid value for ${key}: "${value}". Expected ${rule.integer ? 'an integer' : 'a number'} ${range}.`)
          return
        }
        setSetting(key as 'concurrency', num)
      } else {
        pushLog(
          appState.activeTab,
          `Unknown setting: ${key}. Use concurrency, model, minNavDelayMs, maxNavDelayMs, or loopCooldownMs.`,
        )
        return
      }
      pushLog(appState.activeTab, `Set ${key} = ${value}`)
    },
  })

  registerCommand({
    name: 'verify-login',
    scope: 'global',
    description: 'Check LinkedIn and Gmail login status in the bootstrap browser',
    run: async () => {
      const port = getBrowserServerPort()
      const result = await verifyLogin(port)
      setSessionStatus('linkedin', result.linkedin)
      setSessionStatus('gmail', result.gmail)
      pushLog(
        appState.activeTab,
        result.linkedin
          ? 'Login verified: LinkedIn connected.'
          : 'Not logged in yet (LinkedIn). Log in in tab 1, then run /verify-login again.',
      )
      pushLog(
        appState.activeTab,
        result.gmail
          ? 'Login verified: Gmail connected.'
          : 'Not logged in yet (Gmail). Optional and currently unused by any agent — logging in is not required.',
      )
    },
  })

  registerCommand({
    name: 'exit',
    scope: 'global',
    description: 'Close the browser and exit the application',
    run: async () => {
      pushLog(appState.activeTab, 'Shutting down...')
      // Only destroy the TUI here — main()'s cleanup() (awaiting mountTui())
      // then stops the search agent, both queue workers, and the browser in
      // the correct order. Shutting the browser down here directly used to
      // race with cleanup() doing the same thing out of order.
      const { destroyTui } = await import('../tui/index.tsx')
      destroyTui()
    },
  })
}
