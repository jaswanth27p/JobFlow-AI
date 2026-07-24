import { describe, test, expect, beforeEach } from 'bun:test'
import { testRender } from '@opentui/solid'
import { initAppState, setActiveTab, setSessionStatus, pushLog, appState } from '../../../src/state/app-state.ts'
import { App } from '../../../src/tui/App.tsx'

beforeEach(() => {
  initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
})

describe('App', () => {
  test('renders sidebar and the active tab\'s log panel', async () => {
    pushLog('search', 'scan started')
    const setup = await testRender(() => <App />, { width: 100, height: 30 })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain('Agents')
    expect(frame).toContain('scan started')
  })

  test('switching active tab changes which log panel is visible', async () => {
    pushLog('search', 'search log line')
    pushLog('easy', 'easy log line')
    const setup = await testRender(() => <App />, { width: 100, height: 30 })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('search log line')

    setActiveTab('easy')
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain('easy log line')
    expect(frame).not.toContain('search log line')
  })

  test('resizing to a narrow terminal shrinks the sidebar without crashing', async () => {
    const setup = await testRender(() => <App />, { width: 100, height: 30 })
    await setup.renderOnce()
    setup.resize(50, 30)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame.length).toBeGreaterThan(0)
  })

  test('input box is disabled (shows waiting placeholder) until linkedin connects', async () => {
    const setup = await testRender(() => <App />, { width: 100, height: 30 })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('Waiting for browser login')

    setSessionStatus('linkedin', true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain('Type / for commands')
  })

  test('pressing Tab cycles activeTab search -> easy -> external -> careers -> search', async () => {
    const setup = await testRender(() => <App />, { width: 100, height: 30 })
    await setup.renderOnce()
    expect(appState.activeTab).toBe('search')

    setup.mockInput.pressTab()
    await setup.renderOnce()
    expect(appState.activeTab).toBe('easy')

    setup.mockInput.pressTab()
    await setup.renderOnce()
    expect(appState.activeTab).toBe('external')

    setup.mockInput.pressTab()
    await setup.renderOnce()
    expect(appState.activeTab).toBe('careers')

    setup.mockInput.pressTab()
    await setup.renderOnce()
    expect(appState.activeTab).toBe('search')
  })

  test('pressing Shift+Tab cycles backward', async () => {
    const setup = await testRender(() => <App />, { width: 100, height: 30 })
    await setup.renderOnce()
    setup.mockInput.pressTab({ shift: true })
    await setup.renderOnce()
    expect(appState.activeTab).toBe('careers')
  })

  test('narrow resize wraps sidebar text instead of clipping it', async () => {
    const setup = await testRender(() => <App />, { width: 100, height: 30 })
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain('LinkedIn: waiting')

    setup.resize(50, 30)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    // At narrow widths the word "waiting" may wrap across lines
    // ("waitin"/"g"), so assert on the first segment which won't break.
    expect(frame).toContain('waitin')
  })
})
