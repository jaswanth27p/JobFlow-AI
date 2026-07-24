import { createMemo, createEffect } from 'solid-js'
import { useKeyboard, useTerminalDimensions, useRenderer, useSelectionHandler } from '@opentui/solid'
import { appState, setActiveTab, TAB_IDS } from '../state/app-state.ts'
import { dispatchCommand } from '../commands/dispatch.ts'
import { Sidebar } from './components/Sidebar.tsx'
import { LogPanel } from './components/LogPanel.tsx'
import { InputBar, SuggestionBox, suggestions, selectedSuggestionIndex, setSelectedSuggestionIndex, dismissSuggestions } from './components/InputBar.tsx'
import { ToastOverlay, showToast } from './components/Toast.tsx'
import { TabPickerOverlay, tabPickerOpen, closeTabPicker, moveTabPicker, confirmTabPicker } from './components/TabPicker.tsx'
import { ThemePickerOverlay, themePickerOpen, closeThemePicker, moveThemePicker, confirmThemePicker } from './components/ThemePicker.tsx'
import { QuitConfirmOverlay, quitConfirmOpen, openQuitConfirm, closeQuitConfirm, confirmQuit } from './components/QuitConfirm.tsx'
import { OptionPickerOverlay, optionPickerOpen, closeOptionPicker, moveOptionPicker, confirmOptionPicker } from './components/OptionPicker.tsx'
import { theme } from './theme/current.ts'

const NARROW_WIDTH_THRESHOLD = 70

export function App() {
  const dimensions = useTerminalDimensions()
  const isNarrow = createMemo(() => dimensions().width < NARROW_WIDTH_THRESHOLD)
  const renderer = useRenderer()

  /** Copy the current selection to the clipboard (OSC52) and flash a toast. */
  function copySelection(): boolean {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text) return false
    renderer.copyToClipboardOSC52(text)
    renderer.clearSelection()
    showToast('Copied to clipboard')
    return true
  }

  // Copy-on-select: as soon as a drag-selection is released (no longer
  // dragging), copy it — matches opencode's default "copy on select" UX.
  useSelectionHandler((selection) => {
    if (!selection || selection.isDragging) return
    if (selection.getSelectedText()) copySelection()
  })

  // Force a fresh layout/render pass whenever the visible log list grows.
  // opentui's scrollbox occasionally mislays newly-added rows until the next
  // full relayout (which a terminal resize triggers); nudging the renderer
  // here settles it without the user having to resize.
  createEffect(() => {
    // touch each tab's log length so this re-runs on any new log line
    for (const tab of TAB_IDS) void appState.tabs[tab].logs.length
    renderer.requestRender()
  })

  useKeyboard((key) => {
    // Ctrl+C copies the current selection when there is one (renderer's
    // exitOnCtrlC is off, so it no longer kills the app on its own). With
    // nothing selected, it's the terminal-native "I want to quit" gesture —
    // instead of silently doing nothing, open a confirm dialog rather than
    // exiting immediately, so it can't be hit by accident mid-run.
    if (key.ctrl && key.name === 'c') {
      key.preventDefault()
      if (!copySelection() && !quitConfirmOpen()) openQuitConfirm()
      return
    }

    if (key.ctrl && key.name === 'q') {
      dispatchCommand('/exit')
      return
    }

    // Quit-confirm modal takes priority over everything else while open.
    if (quitConfirmOpen()) {
      if (key.name === 'return' || key.name === 'enter' || key.name === 'kpenter' || key.sequence === 'y') {
        key.preventDefault()
        confirmQuit()
      } else if (key.name === 'escape' || key.sequence === 'n') {
        key.preventDefault()
        closeQuitConfirm()
      }
      return
    }

    // Generic option picker (auto-on mode/duration, /set key, /mark-* job,
    // ...) — same priority tier as the theme/tab pickers, only one popup at a
    // time.
    if (optionPickerOpen()) {
      if (key.name === 'up') {
        key.preventDefault()
        moveOptionPicker(-1)
      } else if (key.name === 'down') {
        key.preventDefault()
        moveOptionPicker(1)
      } else if (key.name === 'return' || key.name === 'enter' || key.name === 'kpenter') {
        key.preventDefault()
        confirmOptionPicker()
      } else if (key.name === 'escape') {
        key.preventDefault()
        closeOptionPicker()
      }
      return
    }

    // Theme picker modal takes priority — only one popup at a time.
    if (themePickerOpen()) {
      if (key.name === 'up') {
        key.preventDefault()
        moveThemePicker(-1)
      } else if (key.name === 'down') {
        key.preventDefault()
        moveThemePicker(1)
      } else if (key.name === 'return' || key.name === 'enter' || key.name === 'kpenter') {
        key.preventDefault()
        confirmThemePicker()
      } else if (key.name === 'escape') {
        key.preventDefault()
        closeThemePicker()
      }
      return
    }

    // Tab picker modal takes priority over everything below while open.
    if (tabPickerOpen()) {
      if (key.name === 'up') {
        key.preventDefault()
        moveTabPicker(-1)
      } else if (key.name === 'down') {
        key.preventDefault()
        moveTabPicker(1)
      } else if (key.name === 'return' || key.name === 'enter' || key.name === 'kpenter') {
        key.preventDefault()
        confirmTabPicker()
      } else if (key.name === 'escape') {
        key.preventDefault()
        closeTabPicker()
      }
      return
    }

    const sugs = suggestions()
    if (sugs.length > 0) {
      if (key.name === 'up') {
        key.preventDefault()
        const idx = selectedSuggestionIndex()
        setSelectedSuggestionIndex(idx < 0 ? sugs.length - 1 : idx > 0 ? idx - 1 : sugs.length - 1)
        return
      }
      if (key.name === 'down') {
        key.preventDefault()
        const idx = selectedSuggestionIndex()
        setSelectedSuggestionIndex(idx < 0 ? 0 : idx < sugs.length - 1 ? idx + 1 : 0)
        return
      }
      if (key.name === 'escape') {
        key.preventDefault()
        dismissSuggestions()
        return
      }
      if (key.name === 'tab') {
        key.preventDefault()
        const idx = selectedSuggestionIndex()
        const cmd = sugs[idx >= 0 ? idx : 0]
        if (cmd) {
          dispatchCommand('/' + cmd.name)
          dismissSuggestions()
        }
        return
      }
      if (key.name === 'return' || key.name === 'enter' || key.name === 'kpenter') {
        const idx = selectedSuggestionIndex()
        if (idx >= 0) {
          key.preventDefault()
          const cmd = sugs[idx]
          if (cmd) {
            dispatchCommand('/' + cmd.name)
            dismissSuggestions()
          }
        }
        return
      }
    }

    if (key.name === 'tab') {
      const currentIndex = TAB_IDS.indexOf(appState.activeTab)
      const nextIndex = key.shift
        ? (currentIndex - 1 + TAB_IDS.length) % TAB_IDS.length
        : (currentIndex + 1) % TAB_IDS.length
      setActiveTab(TAB_IDS[nextIndex]!)
    }
  })

  return (
    // Root box is sized off the live terminal dimensions, NOT height="100%".
    // "100%" resolves against the renderer root, whose height is wrong/zero on
    // the very first paint (before the terminal size is queried) — which left
    // the layout broken until a resize event delivered real dimensions. Binding
    // width/height to useTerminalDimensions() makes it correct from frame one
    // and reactive to resizes. (This is how opencode drives its root box.)
    <box
      flexDirection="column"
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme().background}
      position="relative"
    >
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box width={isNarrow() ? 12 : 30} minHeight={0}>
          <Sidebar />
        </box>
        <box flexDirection="column" flexGrow={1} minHeight={0}>
          <LogPanel tab={appState.activeTab} />
        </box>
      </box>
      <box position="absolute" bottom={3} left={0} width="100%" zIndex={100}>
        <SuggestionBox />
      </box>
      <box flexShrink={0}>
        <InputBar disabled={!appState.session.linkedin} onSubmit={dispatchCommand} />
      </box>
      <ToastOverlay />
      <TabPickerOverlay />
      <ThemePickerOverlay />
      <OptionPickerOverlay />
      <QuitConfirmOverlay />
    </box>
  )
}
