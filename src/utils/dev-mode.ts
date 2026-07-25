/**
 * DEV_LOGS gates the noisy, developer-facing log lines shown in the TUI log
 * panel — the raw agent tool-call trace (`→ browser_goto`, `← browser_snapshot
 * (ok)`, etc.). With it off (the default) the panel shows only the natural-
 * language agent flow a normal user can follow. Everything still goes to the
 * on-disk log file (`data/app.log`) regardless — this only affects what the TUI
 * shows. Set `DEV_LOGS=true` (or `1`) in `.env` to see the raw trace live.
 */
export function isDevLogs(): boolean {
  const v = process.env.DEV_LOGS?.toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/**
 * DEV_CONSOLE controls whether opentui's own console overlay is allowed to
 * show real error output on an uncaught exception/rejection. Off (the
 * default): the output guard in src/tui/index.tsx redirects console.* and
 * raw stdout/stderr writes to the file logger only, and openConsoleOnError
 * is disabled — errors go to data/app.log and never touch the terminal. On:
 * the guard is skipped so opentui's native console.* capture stays intact,
 * and the overlay is allowed to open (and actually show content) on error —
 * useful while developing, not while actually running the automation. Set
 * `DEV_CONSOLE=true` (or `1`) in `.env`.
 */
export function isDevConsole(): boolean {
  const v = process.env.DEV_CONSOLE?.toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}
