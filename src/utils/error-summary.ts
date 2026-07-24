/**
 * Playwright's error messages ship a multi-line "=== logs ===" diagnostic
 * banner (e.g. a navigation timeout: "page.goto: Timeout 30000ms
 * exceeded.\n=== logs ===\nwaiting for navigation until \"domcontentloaded\"\n===").
 * That's useful in the on-disk log file, but every log line the TUI shows is
 * assumed to render as exactly one row (see sanitizeLogLine, which app-state's
 * pushLog applies to everything regardless of source) — a raw multi-line
 * banner defeats that assumption on its own before sanitizeLogLine even runs.
 * Strip it here so the file logger keeps the useful head of the message.
 */
export function summarizeError(err: unknown, maxLength = 240): string {
  const raw = err instanceof Error ? err.message : String(err)
  const bannerStart = raw.search(/={5,}/)
  const beforeBanner = (bannerStart === -1 ? raw : raw.slice(0, bannerStart)).trim()
  const oneLine = (beforeBanner.split('\n')[0] || beforeBanner).replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine
}

/**
 * The single choke point every log line passes through before it can reach
 * the TUI (see pushLog in state/app-state.ts). No matter what produced the
 * string — a caught Playwright error with an embedded multi-line "=== logs
 * ===" banner, a stray '\n' in an LLM-generated message, anything — this
 * guarantees it renders as exactly one row in LogPanel's scrollbox. Without
 * this guarantee, a single oversized/multi-line entry throws off the
 * scrollbox's per-row height accounting and visually spills into neighboring
 * fixed-height chrome (the InputBar sits right below it) until a resize
 * forces a full relayout. Fix it once here instead of sanitizing at every
 * call site that might someday feed pushLog something unruly.
 */
export function sanitizeLogLine(line: string, maxLength = 400): string {
  const oneLine = line.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine
}
