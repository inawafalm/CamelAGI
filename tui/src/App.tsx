// Root component. Owns settings state (model/effort/cwd) and the optional
// picker overlay; wires everything to useAgent (WebSocket to gateway).

import { useCallback, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { useAgent } from "./hooks/useAgent.js"
import { Chat } from "./components/Chat.js"
import { Input } from "./components/Input.js"
import { ApprovalPrompt } from "./components/ApprovalPrompt.js"
import { Welcome } from "./components/Welcome.js"
import { nextMode } from "./components/PermissionBanner.js"
import { ActivityIndicator } from "./components/ActivityIndicator.js"
import { HorizontalRule } from "./components/HorizontalRule.js"
import { BottomBar } from "./components/BottomBar.js"
import { SlashMenu } from "./components/SlashMenu.js"
import { Picker, type PickerItem } from "./components/Picker.js"
import { findCommand, type CommandContext, type Settings } from "./commands/registry.js"
import { DEFAULT_MODEL } from "./config.js"
import type { SlashCommand } from "./commands/registry.js"

const VERSION = "0.5.49"

export interface AppProps {
  model: string
  cwd: string
  wsUrl?: string
  token?: string
}

interface PickerState {
  title: string
  items: PickerItem[]
  initialIndex?: number
  onSelect: (value: string) => void
}

export function App(props: AppProps) {
  const [settings, setSettingsState] = useState<Settings>({
    model: props.model || DEFAULT_MODEL,
    effort: "high",
    cwd: props.cwd,
  })
  const setSettings = useCallback(
    (patch: Partial<Settings>) => setSettingsState(s => ({ ...s, ...patch })),
    [],
  )

  const agent = useAgent({
    model: settings.model,
    effort: settings.effort,
    cwd: settings.cwd,
    wsUrl: props.wsUrl,
    token: props.token,
  })

  const [slashState, setSlashState] = useState<{ matches: SlashCommand[]; selectedIndex: number; argMode?: boolean } | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)

  const cmdCtx: CommandContext = {
    pushSystem: (text, tone) => agent.pushSystem(text, tone),
    agent: {
      state: agent.state,
      clear: agent.clear,
      abort: agent.abort,
      setPermissionMode: agent.setPermissionMode,
      switchModel: agent.switchModel,
      wsSend: agent.wsSend,
      sessionId: agent.sessionId,
    },
    settings,
    setSettings,
    openPicker: opts => setPicker(opts),
    exit: () => process.exit(0),
  }

  const handleSlash = useCallback((name: string, args: string[]) => {
    const cmd = findCommand(name)
    if (!cmd) {
      agent.pushSystem(`Unknown command: /${name}`, "warn")
      return
    }
    void cmd.run(cmdCtx, args)
  }, [cmdCtx, agent])

  const handleCyclePermission = useCallback(() => {
    const next = nextMode(agent.state.permissionMode)
    agent.setPermissionMode(next)
  }, [agent])

  useKeyboard(key => {
    if (key.ctrl && key.name === "c") {
      if (agent.state.status !== "idle") agent.abort()
      else process.exit(0)
    }
    if (key.ctrl && key.name === "l") {
      agent.clear()
    }
  })

  const busy = agent.state.status !== "idle" && agent.state.status !== "error"

  const welcome = (
    <Welcome
      cwd={settings.cwd}
      model={settings.model}
      version={VERSION}
    />
  )

  const overlayOpen = picker !== null || agent.state.pendingApproval !== null

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Chat entries={agent.state.entries} header={welcome} />
      {picker ? (
        <Picker
          title={picker.title}
          items={picker.items}
          initialIndex={picker.initialIndex}
          onSelect={value => {
            const cb = picker.onSelect
            setPicker(null)
            cb(value)
          }}
          onCancel={() => setPicker(null)}
        />
      ) : null}
      {agent.state.pendingApproval ? (
        <ApprovalPrompt
          request={agent.state.pendingApproval}
          onResolve={behavior => agent.respondToApproval(behavior)}
        />
      ) : null}
      {!overlayOpen ? (
        <>
          <ActivityIndicator
            active={busy}
            startedAt={agent.state.runStartedAt}
            label={agent.state.activityLabel}
            liveTokens={agent.state.liveTokens}
          />
          <HorizontalRule />
          <Input
            disabled={busy}
            onSubmit={agent.submit}
            onSlash={handleSlash}
            onAbort={agent.abort}
            onCyclePermission={handleCyclePermission}
            onSlashState={setSlashState}
          />
          <HorizontalRule />
          {slashState && slashState.matches.length > 0 ? (
            <SlashMenu commands={slashState.matches} selectedIndex={slashState.selectedIndex} argMode={slashState.argMode} />
          ) : (
            <BottomBar state={agent.state} />
          )}
        </>
      ) : null}
    </box>
  )
}
