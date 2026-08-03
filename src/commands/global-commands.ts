import { registerCommand } from './registry.ts'
import { listCommandsForTab } from './registry.ts'
import { appState, setSessionStatus, setActiveTab, setSetting, pushLog, TAB_IDS } from '../state/app-state.ts'
import type { TabId, Settings } from '../state/types.ts'
import { getBrowserServerPort } from '../browser/session.ts'
import { verifyLogin } from '../browser/verify-login.ts'
import { startDashboard, stopDashboard, isDashboardRunning, getDashboardUrl } from '../dashboard/server.ts'
import { openTabPicker } from '../tui/components/TabPicker.tsx'
import { openThemePicker } from '../tui/components/ThemePicker.tsx'
import { openOptionPicker } from '../tui/components/OptionPicker.tsx'
import { prefillInput } from '../tui/components/InputBar.tsx'
import { setTheme } from '../tui/theme/current.ts'
import { hasTheme } from '../tui/theme/index.ts'
import { persistThemeName } from '../tui/theme/persist.ts'
import { loadConfig } from '../config/loader.ts'
import { setCurrentConfig } from '../config/current.ts'
import { logger } from '../utils/logger.ts'
import { summarizeError } from '../utils/error-summary.ts'

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
    description: '/tab [search|easy|judge|careers] — switch tab (no arg opens a picker)',
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
    name: 'reload-config',
    scope: 'global',
    description: 'Re-read linkedin-auto.config.ts (url groups, models, prompts, requirements) without restarting',
    run: async () => {
      try {
        const next = await loadConfig()
        setCurrentConfig(next)
        pushLog(appState.activeTab, 'Config reloaded.')
      } catch (err) {
        pushLog(appState.activeTab, `Config reload failed, keeping previous config: ${summarizeError(err)}`)
        logger.error({ err }, 'reload-config failed')
      }
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
    name: 'start-dashboard',
    scope: 'global',
    description: 'Start the local web dashboard (builds its UI bundle first; no-op if already running)',
    run: async () => {
      if (isDashboardRunning()) {
        pushLog(appState.activeTab, `Dashboard already running at ${getDashboardUrl()}.`)
        return
      }
      await startDashboard()
      pushLog(
        appState.activeTab,
        isDashboardRunning() ? `Dashboard started at ${getDashboardUrl()}.` : 'Dashboard failed to start — build error or port in use? Check logs.',
      )
    },
  })

  registerCommand({
    name: 'stop-dashboard',
    scope: 'global',
    description: 'Stop the local web dashboard',
    run: () => {
      if (!isDashboardRunning()) {
        pushLog(appState.activeTab, 'Dashboard is not running.')
        return
      }
      stopDashboard()
      pushLog(appState.activeTab, 'Dashboard stopped.')
    },
  })

  registerCommand({
    name: 'redraw',
    scope: 'global',
    description: 'Force-clear the terminal and repaint the TUI — recovery if a stray raw write ever corrupts the screen and blocks the input box',
    run: async () => {
      const { getRenderer, writeRawToTerminal } = await import('../tui/index.tsx')
      const renderer = getRenderer()
      if (!renderer) return
      // Raw terminal reset+clear (RIS + clear screen + clear scrollback) —
      // needed because corruption here is content actually written into the
      // real terminal/scrollback outside opentui's own tracked buffer, so a
      // plain requestRender() (which only repaints cells opentui thinks
      // changed) can't touch it; confirmed a real terminal resize alone
      // doesn't clear it either. Must go through writeRawToTerminal, not
      // process.stdout.write directly — the output guard (tui/index.tsx)
      // redirects that property to the file logger while the TUI is mounted.
      writeRawToTerminal('\x1Bc\x1B[H\x1B[2J\x1B[3J\x1B[H')
      // Bounce the renderer's dimensions by 1 and back — the same full
      // native-buffer repaint a real terminal resize triggers (see App.tsx's
      // requestRender createEffect comment), so every opentui-owned cell gets
      // rewritten fresh on top of the now-blank terminal instead of being
      // skipped by diffing.
      const { width, height } = renderer
      if (height > 1) {
        renderer.resize(width, height - 1)
        renderer.resize(width, height)
      } else {
        renderer.requestRender()
      }
      pushLog(appState.activeTab, 'Redrew the terminal.')
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
