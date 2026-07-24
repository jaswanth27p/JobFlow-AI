import { createSignal, For, Show } from 'solid-js'
import { TextAttributes } from '@opentui/core'
import { appState, setActiveTab, TAB_IDS } from '../../state/app-state.ts'
import { theme } from '../theme/current.ts'
import type { TabId } from '../../state/types.ts'

const TAB_LABELS: Record<TabId, string> = {
  search: 'Search',
  easy: 'Easy Apply',
  external: 'External Jobs',
  careers: 'Career Pages',
}

export const [tabPickerOpen, setTabPickerOpen] = createSignal(false)
export const [tabPickerIndex, setTabPickerIndex] = createSignal(0)

/** Open the picker with the current tab pre-selected. */
export function openTabPicker(): void {
  const cur = TAB_IDS.indexOf(appState.activeTab)
  setTabPickerIndex(cur < 0 ? 0 : cur)
  setTabPickerOpen(true)
}

export function closeTabPicker(): void {
  setTabPickerOpen(false)
}

/** Move selection by delta, wrapping around both ends. */
export function moveTabPicker(delta: number): void {
  const n = TAB_IDS.length
  setTabPickerIndex((tabPickerIndex() + delta + n) % n)
}

/** Switch to the highlighted tab and close. */
export function confirmTabPicker(): void {
  const tab = TAB_IDS[tabPickerIndex()]
  if (tab) setActiveTab(tab)
  setTabPickerOpen(false)
}

/** Centered modal tab switcher. Render once at the app root (like ToastOverlay).
 * Keyboard (↑/↓/Enter/Esc) is driven from App.tsx; rows are also mouse-clickable. */
export function TabPickerOverlay() {
  return (
    <Show when={tabPickerOpen()}>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        justifyContent="center"
        alignItems="center"
        zIndex={4000}
      >
        <box
          border
          borderColor={theme().accent}
          backgroundColor={theme().backgroundPanel}
          flexDirection="column"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
        >
          <text fg={theme().accent} attributes={TextAttributes.BOLD}>Switch tab</text>
          <text fg={theme().textMuted}> </text>
          <For each={TAB_IDS}>
            {(tab, i) => {
              const selected = () => i() === tabPickerIndex()
              return (
                <box
                  flexDirection="row"
                  border
                  borderColor={selected() ? theme().accent : theme().borderSubtle}
                  backgroundColor={selected() ? theme().backgroundMenu : theme().backgroundElement}
                  onMouseDown={() => {
                    setActiveTab(tab)
                    setTabPickerOpen(false)
                  }}
                >
                  <text fg={selected() ? theme().primary : theme().textMuted}>{selected() ? '▌ ' : '  '}</text>
                  <text
                    fg={selected() ? theme().primary : theme().text}
                    bg={selected() ? theme().background : undefined}
                  >
                    {TAB_LABELS[tab]}
                  </text>
                </box>
              )
            }}
          </For>
          <text fg={theme().textMuted}> </text>
          <text fg={theme().textMuted}>↑/↓ move · Enter select · Esc cancel</text>
        </box>
      </box>
    </Show>
  )
}
