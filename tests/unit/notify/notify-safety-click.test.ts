import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test'
import { notify } from '../../../src/notify/notify.ts'

// See notify-safety.test.ts for the full explanation of why this mock is
// registered in beforeEach rather than at top level: mock.module() is a
// global, process-wide override (not scoped to this file), and
// notify-safety.test.ts registers a conflicting 'node-notifier' mock for the
// same specifier. Re-registering here, immediately before each test, is what
// guarantees THIS file's capturing mock (not the other file's throwing one)
// is the one active when notify() actually runs.
//
// This file also defensively restores notify.ts's own export to the real
// implementation every beforeEach: prompt-channel-notify.test.ts and
// easy-apply-agent-notify.test.ts both call
// mock.module('../../../src/notify/notify.ts', ...), replacing the exported
// `notify` function this file imports as a live ESM binding. Without this
// restore, whichever of those two files' mock happens to be active when this
// test body runs would hijack the `notify(...)` call below entirely — this
// was the actual cause of capturedClickCallback staying undefined (the call
// was silently going to their fake array-push function instead of the real
// notify(), so node-notifier's `once` was never reached).
//
// IMPORTANT: the factory must return a plain object, NOT the ES module
// namespace object `await import(...)` gives you. Passing the namespace
// object straight through to mock.module() made re-registration silently
// stale by one call (verified empirically — a subsequent mock.module() call
// for the same specifier would still observe the PREVIOUS mock's value, one
// call behind). Spreading it into a fresh plain object literal fixes this.
let capturedClickCallback: ((event?: any) => void) | undefined
let realNotifyModule: Record<string, unknown>

beforeAll(async () => {
  // The query suffix is a Bun-runtime-only module-resolution feature
  // (bypasses mock.module's interception); routed through a variable rather
  // than a string literal so tsc's static module resolution doesn't try to
  // find a type declaration for it.
  const notifySpecifier = '../../../src/notify/notify.ts?__real_for_notify_safety_click'
  const real = await import(notifySpecifier)
  realNotifyModule = { ...real }
})

beforeEach(() => {
  capturedClickCallback = undefined

  mock.module('../../../src/notify/notify.ts', () => realNotifyModule)

  mock.module('node-notifier', () => ({
    default: {
      notify: () => {
        // Success - don't throw, allowing the click handler registration to proceed
      },
      once: (event: string, callback: (event?: any) => void) => {
        if (event === 'click') {
          capturedClickCallback = callback
        }
      },
    },
  }))

  mock.module('open', () => ({
    default: async () => {
      throw new Error('no default browser configured')
    },
  }))
})

// Restore both specifiers to their real implementations so this file's mocks
// don't leak into whichever file's tests run next. mock.restore() does not
// undo mock.module() (verified empirically), so the real modules are
// re-registered explicitly, fetched via a query-suffixed specifier that
// bypasses mock.module's interception and always resolves the genuine module.
afterAll(async () => {
  const notifierSpecifier = 'node-notifier?__restore_real_notify_safety_click'
  const realNotifier = await import(notifierSpecifier)
  mock.module('node-notifier', () => ({ ...realNotifier }))

  const openSpecifier = 'open?__restore_real_notify_safety_click'
  const realOpen = await import(openSpecifier)
  mock.module('open', () => ({ ...realOpen }))
})

describe('notify click handler rejection path', () => {
  test('open() rejection in click handler is caught without throwing or unhandled rejection', async () => {
    // This exercises node-notifier's click-to-open path, which notify() only
    // takes on non-macOS platforms (macOS shells out to osascript instead —
    // see notify.ts). Pin process.platform so this test's intent holds
    // regardless of which OS actually runs the suite.
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      // Call notify with an event that has an openUrl
      notify({
        kind: 'external-job-found',
        title: 'Engineer',
        company: 'Acme',
        applyUrl: 'https://acme.com/jobs/1',
      })

      // Verify the click handler was registered
      expect(capturedClickCallback).toBeDefined()
      expect(typeof capturedClickCallback).toBe('function')

      // Invoke the click handler manually - it should not throw synchronously
      // (The async rejection from open() is handled by the .catch() block in notify.ts)
      expect(() => {
        capturedClickCallback!()
      }).not.toThrow()

      // Give any pending promise microtasks a chance to settle.
      // If there were an unhandled promise rejection, it would manifest as:
      // - An unhandledRejection event (which bun test catches and reports)
      // - A console error/warning
      // We await a microtask to ensure the .catch() handler runs.
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
    }
  })
})
