import { getCommand } from './registry.ts'
import { appState, pushLog, isUnlocked } from '../state/app-state.ts'
import { summarizeError } from '../utils/error-summary.ts'

export async function dispatchCommand(input: string): Promise<void> {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    pushLog(appState.activeTab, `Not a command: ${trimmed}. Commands start with /.`)
    return
  }

  const [rawName, ...args] = trimmed.slice(1).split(/\s+/)
  const name = rawName ?? ''
  const command = getCommand(name)

  if (!command) {
    pushLog(appState.activeTab, `Unknown command: /${name}. Try /help.`)
    return
  }

  if (command.scope !== 'global' && !isUnlocked()) {
    pushLog(appState.activeTab, `/${name} is locked until login is verified. Log in in the browser window, then run /verify-login.`)
    return
  }

  try {
    await command.run({ args, rawArgs: args.join(' ') })
  } catch (err) {
    pushLog(appState.activeTab, `/${name} failed: ${summarizeError(err)}`)
  }
}
