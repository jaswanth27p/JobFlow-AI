import { createSignal, For, Show } from 'solid-js'
import { TextAttributes } from '@opentui/core'
import { theme } from '../theme/current.ts'

export interface OptionItem {
  label: string
  value: string
  hint?: string
}

interface PickerConfig {
  title: string
  items: OptionItem[]
  onConfirm: (value: string) => void
}

const [pickerConfig, setPickerConfig] = createSignal<PickerConfig | null>(null)
const [pickerIndex, setPickerIndex] = createSignal(0)

export function optionPickerOpen(): boolean {
  return pickerConfig() !== null
}

/**
 * Generic "pick one of these options" modal, reused by every command whose
 * missing argument is a selection from a bounded/discrete set (auto-on's
 * mode, /set's setting key, /mark-applied's job id, ...) rather than free
 * text — those still just prompt a usage line and let the user type the
 * rest. One picker implementation instead of a bespoke one per command.
 */
export function openOptionPicker(config: PickerConfig): void {
  setPickerConfig(config)
  setPickerIndex(0)
}

export function closeOptionPicker(): void {
  setPickerConfig(null)
}

export function moveOptionPicker(delta: number): void {
  const config = pickerConfig()
  if (!config || config.items.length === 0) return
  const n = config.items.length
  setPickerIndex((pickerIndex() + delta + n) % n)
}

/** Confirms the current selection. The picker closes BEFORE onConfirm runs so
 * a chained onConfirm (e.g. mode picker -> duration picker) can open the next
 * picker itself without fighting the just-closed one. */
export function confirmOptionPicker(): void {
  const config = pickerConfig()
  if (!config) return
  const item = config.items[pickerIndex()]
  setPickerConfig(null)
  if (item) config.onConfirm(item.value)
}

export function OptionPickerOverlay() {
  return (
    <Show when={pickerConfig()}>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        justifyContent="center"
        alignItems="center"
        zIndex={4003}
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
          <text fg={theme().accent} attributes={TextAttributes.BOLD}>
            {pickerConfig()!.title}
          </text>
          <text fg={theme().textMuted}> </text>
          <For each={pickerConfig()!.items}>
            {(item, i) => {
              const selected = () => i() === pickerIndex()
              return (
                <box
                  flexDirection="row"
                  backgroundColor={selected() ? theme().backgroundMenu : theme().backgroundElement}
                  onMouseDown={() => {
                    setPickerIndex(i())
                    confirmOptionPicker()
                  }}
                >
                  <text fg={selected() ? theme().accent : theme().textMuted}>{selected() ? '▌ ' : '  '}</text>
                  <text fg={selected() ? theme().accent : theme().text}>{item.label}</text>
                  <Show when={item.hint}>
                    <text fg={theme().textMuted}> — {item.hint}</text>
                  </Show>
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
