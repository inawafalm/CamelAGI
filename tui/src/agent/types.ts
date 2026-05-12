// Agent protocol types. Mirrors node-host/host.mjs in/out shapes and the
// normalized event shape produced by parse.ts (which is itself a port of
// liquidagente-desktop/src/lib/localAgent.ts:58-188).

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan"

/** Which agent runtime to spawn.
 *  - cli:  the `claude` binary directly. Auth via claude-cli login. Same path
 *          the desktop uses by default. Best for users who already ran
 *          `claude login`.
 *  - sdk:  node-host/host.mjs (the Node sidecar that wraps the Agent SDK).
 *          Needed for direct API key usage or gateway-proxied auth. */
export type AgentRuntime = "cli" | "sdk"

/** Config passed to host.mjs via LIQUIDAGENTE_CONFIG env var (sdk mode) or
 *  translated to CLI args (cli mode). */
export interface AgentConfig {
  prompt: string
  model: string
  cwd: string
  runtime?: AgentRuntime
  baseUrl?: string
  authToken?: string
  systemPrompt?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  effort?: string
  sessionId?: string
  resume?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  tools?: string[]
  agentId?: string
}

export interface ApprovalRequest {
  id: string
  tool: string
  input: Record<string, unknown>
  blockedPath?: string
  decisionReason?: string
}

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "stream_text"; text: string }
  | { type: "thinking"; state: "start" | "end" }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; preview: string; isError?: boolean }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "permission_denied"; id: string; message: string }
  | { type: "subagent_start"; agentId: string; taskId?: string }
  | { type: "subagent_progress"; agentId: string; toolCount?: number; duration?: number }
  | { type: "subagent_done"; agentId: string; toolUseId?: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "done"; response: string; subtype?: string; usage?: UsageInfo }
  | { type: "error"; message: string }

export type ApprovalBehavior = "allow" | "deny"

/** Sent on host.mjs stdin in response to an approval-request. */
export interface ApprovalResponse {
  type: "approval-response"
  id: string
  behavior: ApprovalBehavior
  message?: string
}
