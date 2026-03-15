// Channel: pluggable messaging platform interface

import type { Config } from "../core/config.js";

/** Minimal interface every channel must implement */
export interface Channel {
  /** Unique channel type identifier (e.g., "telegram", "discord", "slack") */
  readonly type: string;

  /** Start all instances for agents that have this channel configured. Returns started agent IDs. */
  start(getConfig: () => Config, getSystemPrompt: () => string): Promise<string[]>;

  /** Stop all running instances of this channel. */
  stop(): void;

  /** Reconcile running state with config: start new instances, stop removed ones. */
  reconcile(getConfig: () => Config, getSystemPrompt: () => string): Promise<void>;

  /** Get IDs of agents currently active on this channel. */
  getActiveAgentIds(): string[];

  /** Start a single agent's channel instance (hot-start after config change). */
  startAgent(agentId: string, getConfig: () => Config, getSystemPrompt: () => string): Promise<void>;

  /** Stop a single agent's channel instance. Returns true if it was running. */
  stopAgent(agentId: string): boolean;
}
