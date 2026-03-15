// Channel loader: lazily imports and registers configured channels

import type { Config } from "../core/config.js";
import { getConfiguredChannelTypes, registerChannel } from "./registry.js";

const loaded = new Set<string>();

/** Load and register channels based on what's configured. */
export async function loadChannels(config: Config): Promise<void> {
  const types = getConfiguredChannelTypes(config);

  if (types.includes("telegram") && !loaded.has("telegram")) {
    const { TelegramChannel } = await import("./telegram.js");
    registerChannel(new TelegramChannel());
    loaded.add("telegram");
  }

  if (types.includes("discord") && !loaded.has("discord")) {
    const { DiscordChannel } = await import("./discord.js");
    registerChannel(new DiscordChannel());
    loaded.add("discord");
  }
}

export { startAllChannels, stopAllChannels, reconcileAllChannels, getAllChannels } from "./registry.js";
