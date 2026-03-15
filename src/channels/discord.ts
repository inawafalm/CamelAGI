// Discord channel: implements Channel + ChannelAdapter using discord.js

import { Client, GatewayIntentBits, Partials, type Message, type TextChannel } from "discord.js";
import type { Channel } from "./types.js";
import type { ChannelAdapter, RuntimeState } from "./adapter.js";
import { createRuntimeState, type ResolvedAgentBase } from "./adapter.js";
import { handleCommand, handleMessage, resolveAgentBase } from "./handler.js";
import type { Config } from "../core/config.js";
import { log as slog } from "../core/log.js";

interface BotInstance {
  client: Client;
  agentId: string;
  runtime: RuntimeState;
}

const activeBots = new Map<string, BotInstance>();

export class DiscordChannel implements Channel {
  readonly type = "discord";

  async start(getConfig: () => Config, getSystemPrompt: () => string): Promise<string[]> {
    const config = getConfig();
    const started: string[] = [];

    for (const [id, agent] of Object.entries(config.agents)) {
      if (!agent.discord?.botToken) continue;
      if (activeBots.has(id)) continue;
      try {
        await startBot(id, agent.discord.botToken, agent.discord, getConfig, getSystemPrompt);
        started.push(id);
      } catch (err) {
        slog.error("discord", `Failed to start bot for ${id}`, { error: String(err) });
      }
    }

    return started;
  }

  stop(): void {
    for (const [id, bot] of activeBots) {
      bot.client.destroy();
      slog.info("discord", `Stopped bot: ${id}`);
    }
    activeBots.clear();
  }

  async reconcile(getConfig: () => Config, getSystemPrompt: () => string): Promise<void> {
    const config = getConfig();
    const running = new Set(activeBots.keys());

    // Start new
    for (const [id, agent] of Object.entries(config.agents)) {
      if (!agent.discord?.botToken) continue;
      if (running.has(id)) continue;
      try {
        await startBot(id, agent.discord.botToken, agent.discord, getConfig, getSystemPrompt);
        slog.info("discord", `Hot-started bot: ${id}`);
      } catch {}
    }

    // Stop removed
    for (const id of running) {
      if (!config.agents[id]?.discord?.botToken) {
        const bot = activeBots.get(id);
        if (bot) bot.client.destroy();
        activeBots.delete(id);
        slog.info("discord", `Stopped bot: ${id} (agent removed)`);
      }
    }
  }

  getActiveAgentIds(): string[] {
    return [...activeBots.keys()];
  }

  async startAgent(agentId: string, getConfig: () => Config, getSystemPrompt: () => string): Promise<void> {
    const config = getConfig();
    const agent = config.agents[agentId];
    if (!agent?.discord?.botToken) throw new Error(`No Discord bot token for agent "${agentId}"`);
    await startBot(agentId, agent.discord.botToken, agent.discord, getConfig, getSystemPrompt);
  }

  stopAgent(agentId: string): boolean {
    const bot = activeBots.get(agentId);
    if (!bot) return false;
    bot.client.destroy();
    activeBots.delete(agentId);
    return true;
  }
}

// ─── Bot setup ────────────────────────────────────────────────────────

interface DiscordConfig {
  botToken: string;
  allowedChannels: string[];
  allowedRoles: string[];
  mentionOnly: boolean;
}

async function startBot(
  agentId: string,
  token: string,
  discordConfig: DiscordConfig,
  getConfig: () => Config,
  getSystemPrompt: () => string,
): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // needed for DMs
  });

  const runtime = createRuntimeState();
  const instance: BotInstance = { client, agentId, runtime };

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    // Channel restriction
    if (discordConfig.allowedChannels.length > 0 && !discordConfig.allowedChannels.includes(msg.channelId)) {
      return;
    }

    // Role restriction (skip for DMs)
    if (discordConfig.allowedRoles.length > 0 && msg.guild) {
      const member = msg.member;
      if (member && !member.roles.cache.some(r => discordConfig.allowedRoles.includes(r.name))) {
        return;
      }
    }

    // Mention-only in guilds
    const isDM = !msg.guild;
    if (!isDM && discordConfig.mentionOnly) {
      const mentioned = msg.mentions.has(client.user!);
      const isReply = msg.reference?.messageId != null;
      // Check if reply is to the bot
      let replyToBot = false;
      if (isReply) {
        try {
          const refMsg = await msg.channel.messages.fetch(msg.reference!.messageId!);
          replyToBot = refMsg.author.id === client.user!.id;
        } catch {}
      }
      if (!mentioned && !replyToBot) return;
    }

    // Strip mention
    let text = msg.content;
    if (client.user) {
      text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
    }
    if (!text) return;

    const conversationId = msg.channelId;
    const sessionId = runtime.sessions.get(conversationId) ?? `dc:${agentId}:${conversationId}`;

    const agent = resolveAgentBase(agentId, getConfig(), getSystemPrompt(), {
      model: runtime.models.get(conversationId),
      thinking: runtime.thinking.get(conversationId),
      effort: runtime.effort.get(conversationId),
    });

    // Check for commands
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      const result = await handleCommand(cmd, arg, {
        agentId,
        conversationId,
        sessionId,
        agent,
        runtime,
        getConfig,
      });
      if (result.handled && result.response) {
        if (result.asFile) {
          await msg.reply({ files: [{ attachment: Buffer.from(result.response), name: result.asFile }] });
        } else {
          await sendSafe(msg, result.response);
        }
        return;
      }
    }

    // Build adapter for this message context
    const adapter = createAdapter(msg, client);

    await handleMessage({
      channelType: "discord",
      agentId,
      conversationId,
      sessionId,
      text,
      agent,
      adapter,
      getConfig,
      onApproval: async (event) => {
        await sendSafe(msg, `**Tool approval needed:** ${event.toolName}\n\`\`\`\n${event.preview}\n\`\`\`\nReply with \`allow\`, \`always\`, or \`deny\``);
      },
    });
  });

  client.on("error", (err) => {
    slog.error("discord", "Client error", { agent: agentId, error: err.message });
  });

  await client.login(token);
  activeBots.set(agentId, instance);
  slog.info("discord", `Bot logged in as ${client.user?.tag}`, { agent: agentId });
}

// ─── Adapter ──────────────────────────────────────────────────────────

function createAdapter(msg: Message, client: Client): ChannelAdapter {
  const channel = msg.channel as TextChannel;

  return {
    maxMessageLength: 2000,
    throttleMs: 600,

    async send(conversationId: string, text: string): Promise<string> {
      const sent = await channel.send(text);
      return sent.id;
    },

    async edit(_conversationId: string, messageId: string, text: string): Promise<void> {
      try {
        const existing = await channel.messages.fetch(messageId);
        await existing.edit(text);
      } catch {}
    },

    async delete(_conversationId: string, messageId: string): Promise<void> {
      try {
        const existing = await channel.messages.fetch(messageId);
        await existing.delete();
      } catch {}
    },

    async setStatus(conversationId: string, status: string): Promise<void> {
      try {
        if (status === "thinking" || status === "tool") {
          await channel.sendTyping();
        }
      } catch {}
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function sendSafe(msg: Message, text: string): Promise<void> {
  if (text.length <= 2000) {
    await msg.reply(text);
    return;
  }
  // Split long messages
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 2000));
    remaining = remaining.slice(2000);
  }
  for (const chunk of chunks) {
    await msg.reply(chunk);
  }
}
