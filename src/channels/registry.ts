// Channel registry: register, start, stop, reconcile all channels

import type { Channel } from "./types.js";
import type { Config } from "../core/config.js";

const channels = new Map<string, Channel>();

/** Register a channel implementation. Throws if already registered. */
export function registerChannel(channel: Channel): void {
  if (channels.has(channel.type)) {
    throw new Error(`Channel "${channel.type}" is already registered`);
  }
  channels.set(channel.type, channel);
}

/** Get a registered channel by type. */
export function getChannel(type: string): Channel | undefined {
  return channels.get(type);
}

/** Get all registered channels. */
export function getAllChannels(): Channel[] {
  return [...channels.values()];
}

/** Check which channel types have config for at least one agent. */
export function getConfiguredChannelTypes(config: Config): string[] {
  const types = new Set<string>();

  // Legacy top-level telegram
  if (config.telegram.botToken) types.add("telegram");

  // Per-agent channels
  for (const agent of Object.values(config.agents)) {
    if (agent.telegram?.botToken) types.add("telegram");
    if (agent.discord?.botToken) types.add("discord");
  }

  return [...types];
}

/**
 * Start all channels that have config.
 * Returns a map of channel type -> started agent IDs.
 */
export async function startAllChannels(
  getConfig: () => Config,
  getSystemPrompt: () => string,
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();

  for (const channel of channels.values()) {
    try {
      const started = await channel.start(getConfig, getSystemPrompt);
      if (started.length > 0) results.set(channel.type, started);
    } catch (err) {
      console.error(`[channels] Failed to start ${channel.type}:`, err);
    }
  }

  return results;
}

/** Stop all channels. */
export function stopAllChannels(): void {
  for (const channel of channels.values()) {
    try { channel.stop(); } catch { /* best effort */ }
  }
}

/** Reconcile all channels after config change. */
export async function reconcileAllChannels(
  getConfig: () => Config,
  getSystemPrompt: () => string,
): Promise<void> {
  for (const channel of channels.values()) {
    try {
      await channel.reconcile(getConfig, getSystemPrompt);
    } catch (err) {
      console.error(`[channels] Failed to reconcile ${channel.type}:`, err);
    }
  }
}
