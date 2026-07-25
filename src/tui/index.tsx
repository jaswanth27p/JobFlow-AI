import { render } from '@opentui/solid'
import { createCliRenderer, CliRenderer, engine } from '@opentui/core'
import { App } from './App.tsx'
import { logger } from '../utils/logger.ts'
import { isDevConsole } from '../utils/dev-mode.ts'

let rendererInstance: CliRenderer | null = null

/** Exposed so command handlers (outside the component tree) can reach the
 * live renderer — e.g. /redraw's terminal-clear + forced repaint. */
export function getRenderer(): CliRenderer | null {
  return rendererInstance
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'
type StdoutWrite = typeof process.stdout.write
let originalConsole: Record<ConsoleMethod, (...args: unknown[]) => void> | null = null
let originalStdoutWrite: StdoutWrite | null = null
let originalStderrWrite: StdoutWrite | null = null

/** The only sanctioned way for app code to put raw bytes on the terminal
 * while installOutputGuard() is active (e.g. /redraw's ANSI clear sequence)
 * — everything else going through process.stdout.write gets redirected to
 * the file logger instead. Calls the pre-patch original directly, so it
 * still works even while the guard has the public property redirected. */
export function writeRawToTerminal(text: string): void {
  ;(originalStdoutWrite ?? process.stdout.write).call(process.stdout, text)
}

/**
 * opentui patches console.* itself (its "console-overlay" consoleMode, on by
 * default) to keep stray calls off the raw terminal — but opencode (built on
 * the same opentui) hit real-world cases where a plain console.log still
 * corrupted the TUI frame in production (github.com/anomalyco/opencode PR
 * #6546: debug console.log calls bled straight to stdout and broke
 * rendering). Ours runs LAST — installed after createCliRenderer() so it
 * overwrites opentui's own patch — and is the belt-and-suspenders net for any
 * console.* call we haven't traced to a specific silenced logger (see
 * agent.__setLogger(noopLogger) / AgentBrowser.__setLogger(noopLogger) at
 * agent construction sites): route it to the file-only pino logger instead of
 * letting it anywhere near stdout/stderr, same as unhandledRejection in
 * src/index.ts.
 *
 * console.* alone isn't the whole surface, though — anything calling
 * process.stdout.write/stderr.write directly bypasses it entirely. In this
 * app's screenMode ("alternate-screen", the default — "capture-stdout" mode
 * isn't legal outside "split-footer"), opentui itself leaves
 * process.stdout.write as a raw passthrough (see its own construction-time
 * `this.stdout.write = this.realStdoutWrite`), so nothing currently guards
 * it. Patching the public write property here is safe: opentui's own frame
 * rendering never goes through it — it calls its own pre-captured original
 * function directly — so this only catches third-party direct writes.
 */
function installOutputGuard(): void {
  if (originalConsole) return
  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }
  console.log = (...args: unknown[]) => logger.info({ args }, 'console.log')
  console.info = (...args: unknown[]) => logger.info({ args }, 'console.info')
  console.warn = (...args: unknown[]) => logger.warn({ args }, 'console.warn')
  console.error = (...args: unknown[]) => logger.error({ args }, 'console.error')
  console.debug = (...args: unknown[]) => logger.debug({ args }, 'console.debug')

  originalStdoutWrite = process.stdout.write.bind(process.stdout)
  originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown) => {
    logger.info({ chunk: String(chunk) }, 'stray process.stdout.write')
    return true
  }) as StdoutWrite
  process.stderr.write = ((chunk: unknown) => {
    logger.error({ chunk: String(chunk) }, 'stray process.stderr.write')
    return true
  }) as StdoutWrite
}

function restoreOutputGuard(): void {
  if (!originalConsole) return
  console.log = originalConsole.log
  console.info = originalConsole.info
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.debug = originalConsole.debug
  originalConsole = null

  // Belt-and-suspenders — opentui already resets process.stdout.write itself
  // on destroy() (right after emitting 'destroy', which is what triggers
  // this), but it never touches stderr.write at all, so this is load-bearing
  // for stderr and just redundant-but-harmless for stdout.
  if (originalStdoutWrite) {
    process.stdout.write = originalStdoutWrite
    originalStdoutWrite = null
  }
  if (originalStderrWrite) {
    process.stderr.write = originalStderrWrite
    originalStderrWrite = null
  }
}

export async function mountTui(): Promise<void> {
  // NOT `new Promise(async (resolve) => {...})` (the previous shape here): an
  // async executor's body runs as its own detached microtask, so any throw
  // inside it (createCliRenderer, render()) becomes an unhandled rejection
  // that never reaches this function's caller at all — it bypasses main()'s
  // try/catch and the pino logger entirely, and prints raw straight over the
  // TUI's frame instead (the "unreadable, uncopyable error on top of the
  // TUI" failure mode). Doing the async setup in this real async function
  // (whose own rejection DOES propagate to the caller via `await mountTui()`)
  // and keeping the Promise executor itself synchronous fixes that.
  const renderer = await createCliRenderer({
    // Ctrl+C must not kill the renderer — we bind it to "copy selection"
    // in App.tsx instead (see there). Terminal-native select+copy can't
    // work in a live-repainting TUI (the 30fps repaint wipes the marked
    // text), so we use opentui's OWN mouse selection + OSC52 clipboard
    // copy — which requires mouse reporting left ON (the default). Same
    // approach opencode uses.
    exitOnCtrlC: false,
    // opentui registers its own uncaughtException/unhandledRejection
    // listeners and, by default, opens the console overlay on either (even
    // though our own handlers in src/index.ts already log these to file —
    // Node fires all registered listeners for an event, so both run). With
    // DEV_CONSOLE off (the default), installOutputGuard() below redirects
    // console.error to the file logger, so that overlay would open blank
    // with no visible text and just sit on top of the TUI blocking it — set
    // DEV_CONSOLE=true to see real error output in the overlay instead.
    openConsoleOnError: isDevConsole(),
    onDestroy: () => {
      rendererInstance = null
    },
  })
  rendererInstance = renderer
  // Must run AFTER createCliRenderer() — opentui installs its own console.*
  // and stdout.write patches during renderer construction, and whichever
  // patch runs last wins. Skipped entirely under DEV_CONSOLE so opentui's
  // own capture (and the overlay opened above) can show real content.
  if (!isDevConsole()) {
    installOutputGuard()
  }

  return new Promise<void>((resolve, reject) => {
    // CliRenderer extends EventEmitter and emits 'destroy' from inside its
    // own destroy() (before the onDestroy callback above runs) — listening
    // here, rather than threading another callback through the config, needs
    // no assumption about what else destroy() does internally.
    renderer.once('destroy', () => {
      restoreOutputGuard()
      resolve()
    })
    try {
      engine.attach(renderer)
      render(() => <App />, renderer)
    } catch (err) {
      reject(err)
    }
  })
}

export function destroyTui(): void {
  if (rendererInstance) {
    rendererInstance.destroy()
  }
}
