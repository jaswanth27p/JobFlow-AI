import { For, Show } from 'solid-js'
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

export function Sidebar() {
  const tabAccent = (tab: TabId) => {
    if (tab === 'search') return theme().accent
    if (tab === 'easy') return theme().success
    if (tab === 'external') return theme().secondary
    return theme().warning
  }

  const statusColor = (tab: TabId) => {
    const status = appState.tabs[tab].status
    if (status === 'needs_input') return theme().warning
    if (status === 'running') return tabAccent(tab)
    return theme().textMuted
  }

  return (
    <scrollbox
      border
      borderColor={theme().border}
      backgroundColor={theme().backgroundPanel}
      width="100%"
      flexGrow={1}
      minHeight={0}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      scrollY
      viewportCulling={false}
      contentOptions={{ flexDirection: 'column' }}
    >
      <text fg={theme().accent} attributes={TextAttributes.BOLD}>Session</text>
      <text fg={appState.session.linkedin ? theme().success : theme().textMuted}>
        ● LinkedIn: {appState.session.linkedin ? 'connected' : 'waiting'}
      </text>
      <text fg={appState.session.gmail ? theme().accent : theme().textMuted}>
        ● Gmail: {appState.session.gmail ? 'connected' : 'waiting'}
      </text>

      <text fg={theme().text}> </text>
      <text fg={theme().success} attributes={TextAttributes.BOLD}>Agents</text>
      <For each={TAB_IDS}>
        {(tab) => (
          <box flexDirection="column" paddingBottom={1}>
            <box
              flexDirection="row"
              border
              borderColor={appState.activeTab === tab ? tabAccent(tab) : theme().borderSubtle}
              backgroundColor={appState.activeTab === tab ? theme().backgroundMenu : theme().backgroundElement}
              paddingLeft={1}
              paddingRight={1}
              onMouseDown={() => setActiveTab(tab)}
            >
              <text fg={tabAccent(tab)}>{appState.activeTab === tab ? '▌' : ' '}</text>
              <text fg={appState.activeTab === tab ? tabAccent(tab) : theme().text} attributes={TextAttributes.BOLD}>
                {TAB_LABELS[tab]}
              </text>
            </box>
            <text
              fg={statusColor(tab)}
              bg={appState.activeTab === tab ? theme().backgroundMenu : undefined}
            >
              status: {appState.tabs[tab].status}
              {appState.tabs[tab].status === 'needs_input' ? ' ⚠' : ''}
            </text>
            <Show when={appState.tabs[tab].step}>
              <text fg={theme().textMuted}>  ↳ {appState.tabs[tab].step}</text>
            </Show>
            <Show when={appState.tabs[tab].needsInputQuestion}>
              <text fg={theme().warning}>  ? {appState.tabs[tab].needsInputQuestion}</text>
            </Show>
          </box>
        )}
      </For>
    </scrollbox>
  )
}
