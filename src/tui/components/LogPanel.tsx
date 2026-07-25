import { For } from 'solid-js'
import { appState } from '../../state/app-state.ts'
import { theme } from '../theme/current.ts'
import type { TabId } from '../../state/types.ts'

export function LogPanel(props: { tab: TabId }) {
  const lineColor = (line: string) => {
    const value = line.toLowerCase()
    if (value.includes('error') || value.includes('failed')) return theme().error
    if (value.includes('warn')) return theme().warning
    if (value.includes('success') || value.includes('done') || value.includes('applied')) return theme().success
    if (value.includes('verify') || value.includes('login')) return theme().accent
    if (value.includes('queue') || value.includes('search')) return theme().success
    return theme().text
  }

  return (
    <scrollbox
      border
      borderColor={theme().border}
      backgroundColor={theme().backgroundPanel}
      flexGrow={1}
      minHeight={0}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      scrollY
      stickyScroll
      stickyStart="bottom"
      viewportCulling={false}
      contentOptions={{ flexDirection: 'column' }}
    >
      <For each={appState.tabs[props.tab].logs}>
        {(line) => (
          <box flexDirection="row">
            <text fg={lineColor(line)}>▸</text>
            <text fg={lineColor(line)}> {line}</text>
          </box>
        )}
      </For>
    </scrollbox>
  )
}
