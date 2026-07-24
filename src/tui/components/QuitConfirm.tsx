import { createSignal, Show } from 'solid-js'
import { TextAttributes } from '@opentui/core'
import { theme } from '../theme/current.ts'
import { dispatchCommand } from '../../commands/dispatch.ts'

export const [quitConfirmOpen, setQuitConfirmOpen] = createSignal(false)

export function openQuitConfirm(): void {
  setQuitConfirmOpen(true)
}

export function closeQuitConfirm(): void {
  setQuitConfirmOpen(false)
}

export function confirmQuit(): void {
  setQuitConfirmOpen(false)
  void dispatchCommand('/exit')
}

/** Centered modal, same style as ThemePickerOverlay/TabPickerOverlay. Ctrl+C
 * opens this when there's no selection to copy instead of doing nothing. */
export function QuitConfirmOverlay() {
  return (
    <Show when={quitConfirmOpen()}>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        justifyContent="center"
        alignItems="center"
        zIndex={4002}
      >
        <box
          border
          borderColor={theme().error}
          backgroundColor={theme().backgroundPanel}
          flexDirection="column"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
        >
          <text fg={theme().error} attributes={TextAttributes.BOLD}>
            Quit the app?
          </text>
          <text fg={theme().textMuted}> </text>
          <text fg={theme().text}>Closes the browser and stops all agents.</text>
          <text fg={theme().textMuted}> </text>
          <text fg={theme().textMuted}>Enter/y confirm · Esc/n cancel</text>
        </box>
      </box>
    </Show>
  )
}
