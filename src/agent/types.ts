// Agent types — shared between Claude SDK and Cursor SDK paths

import type { Message, TokenUsage } from "../core/types.js";
import type { ApprovalMode } from "../extensions/approvals.js";
import type { SdkTag } from "../session.js";

export interface RunResult {
  response: string;
  newMessages: Message[];
  usage: TokenUsage | null;
  sessionId?: string;
}

export type AgentEvent =
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; preview: string }
  | { type: "chunk"; text: string }
  | { type: "stream_text"; text: string }
  | { type: "thinking"; state: "start" | "end" }
  | { type: "thinking_delta"; text: string }
  | { type: "init"; sessionId: string }
  | { type: "subagent_start"; agentId: string; taskId?: string }
  | { type: "subagent_progress"; agentId: string; toolCount?: number; duration?: number }
  | { type: "subagent_done"; agentId: string; toolUseId?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "approval_request"; id: string; toolName: string; preview: string }
  | { type: "approval_resolved"; id: string; decision: string };

export interface AgentOpts {
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  timeoutMs?: number;
  toolPolicy?: { allow: string[]; deny: string[] };
  hooksEnabled?: boolean;
  sessionId?: string;
  thinking?: string;
  effort?: "low" | "medium" | "high" | "max";
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  agentId?: string;
  provider?: string;
  baseUrl?: string;
  sdk?: SdkTag;
  cursorApiKey?: string;
  approvals?: { mode: ApprovalMode; allowlist: string[]; timeoutSeconds: number; fallback: "deny" | "allow"; forwardTo?: number };
  mcpServers?: Record<string,
    | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> }
    | { type: "sse"; url: string; headers?: Record<string, string> }
  >;
  adminDeps?: {
    getSystemPrompt: () => string;
  };
}
