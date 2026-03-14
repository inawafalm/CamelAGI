// Shared types

import type { z } from "zod";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Tool definition for custom MCP tools */
export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
