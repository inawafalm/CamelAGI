// Channel adapter: platform-specific primitives each channel provides

import type { Config } from "../core/config.js";

/** Resolved agent config (channel-agnostic) */
export interface ResolvedAgentBase {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  thinking: Config["thinking"];
  effort: Config["effort"];
  maxTurns: number;
}

/** Runtime overrides per conversation */
export interface RuntimeOverrides {
  model?: string;
  thinking?: Config["thinking"];
  effort?: Config["effort"];
}

/** Per-conversation runtime state */
export interface RuntimeState {
  models: Map<string, string>;
  thinking: Map<string, Config["thinking"]>;
  effort: Map<string, Config["effort"]>;
  /** Session override: conversationId → custom sessionId (for shared sessions) */
  sessions: Map<string, string>;
}

export function createRuntimeState(): RuntimeState {
  return {
    models: new Map(),
    thinking: new Map(),
    effort: new Map(),
    sessions: new Map(),
  };
}

/** What each channel provides to the shared handler */
export interface ChannelAdapter {
  /** Send a new message, return a message ID for later editing */
  send(conversationId: string, text: string): Promise<string>;

  /** Edit an existing message by ID */
  edit(conversationId: string, messageId: string, text: string): Promise<void>;

  /** Delete a message */
  delete(conversationId: string, messageId: string): Promise<void>;

  /** Set a status indicator (emoji reaction, typing, etc.) — best effort */
  setStatus(conversationId: string, status: "received" | "thinking" | "tool" | "extended_thinking" | "done" | "error"): Promise<void>;

  /** Send a file (for exports). Optional — falls back to sending as text. */
  sendFile?(conversationId: string, filename: string, content: string): Promise<void>;

  /** Max characters per message (Telegram: 4096, Discord: 2000, Slack: 4000) */
  maxMessageLength: number;

  /** Throttle between draft edits in ms */
  throttleMs: number;
}
