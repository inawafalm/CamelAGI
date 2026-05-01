// CamelAGI TUI — gateway WebSocket client
// All agent execution flows through the gateway.

import {
  CombinedAutocompleteProvider,
  Container,
  Loader,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  type SlashCommand,
} from "@mariozechner/pi-tui";
import { WebSocket } from "ws";
import { loadConfig, saveConfig, ensureDirs, type Config } from "../core/config.js";
import { seedWorkspace } from "../workspace.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { loadMessages, listSessions, getSessionMeta } from "../session.js";
import type { SdkTag } from "../session.js";
import { getSessionUsage, formatTokens } from "../usage.js";
import type { Message } from "../core/types.js";
import { execFile } from "node:child_process";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import { HintBar } from "./components/hint-bar.js";
import { buildWelcomeScreen } from "./components/welcome.js";
import { theme, editorTheme, selectListTheme } from "./theme.js";
import type { TuiCtx, TuiState } from "./context.js";
import { handleWsMessage } from "./ws-handler.js";
import { handleCommand, handleAgentCreation } from "./commands.js";
import { VERSION } from "../core/version.js";

export interface TuiOptions {
  session?: string;
  wsUrl?: string;
}

function getSlashCommands(): SlashCommand[] {
  return [
    { name: "help", description: "Show available commands and shortcuts" },
    { name: "model", description: "Switch model or show current" },
    { name: "config", description: "Show current configuration" },
    { name: "sessions", description: "List saved sessions" },
    { name: "session", description: "Switch to a session" },
    { name: "clear", description: "Clear chat history" },
    { name: "tools", description: "Toggle tool output expand/collapse" },
    { name: "skills", description: "List active skills" },
    { name: "think", description: "Set thinking level (off|low|medium|high)" },
    { name: "effort", description: "Set effort level (low|medium|high|max)" },
    { name: "context", description: "Show context breakdown (injected files, tokens)" },
    { name: "status", description: "Show session status" },
    { name: "compact", description: "Force context compaction now" },
    { name: "new", description: "Start a new session" },
    { name: "agents", description: "List, create, or remove agents" },
    { name: "soul", description: "View/edit an agent's SOUL.md" },
    { name: "cursor", description: "Switch to Cursor SDK runtime" },
    { name: "claude", description: "Switch to Claude SDK runtime" },
    { name: "cancel", description: "Cancel agent creation" },
    { name: "setup", description: "Run setup wizard" },
    { name: "exit", description: "Exit CamelAGI" },
    { name: "quit", description: "Exit CamelAGI" },
  ];
}

export async function runTui(opts: TuiOptions = {}) {
  ensureDirs();
  seedWorkspace();
  const config = loadConfig();
  const systemPrompt = buildSystemPrompt(config.systemPrompt, config.skills);

  const state: TuiState = {
    config,
    sid: opts.session ?? `session-${Date.now()}`,
    messages: loadMessages(opts.session ?? `session-${Date.now()}`),
    currentModel: config.model,
    currentThinking: config.thinking,
    currentEffort: config.effort,
    currentSdk: "claude" as SdkTag,
    systemPrompt,
    toolsExpanded: false,
    toolCounter: 0,
    pendingMessage: null,
    isThinking: false,
    agentCreation: null,
    sdkSessionId: undefined,
  };

  // --- Connect to gateway ---

  const wsUrl = opts.wsUrl;
  if (!wsUrl) throw new Error("wsUrl is required — TUI connects to gateway via WebSocket");

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  const wsSend = (data: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  };

  // --- Build UI ---

  const tui = new TUI(new ProcessTerminal());
  const statusContainer = new Container();
  const chatLog = new ChatLog();
  const editor = new CustomEditor(tui, editorTheme);
  const hintBar = new HintBar();
  const root = new Container();
  root.addChild(chatLog);
  root.addChild(statusContainer);
  root.addChild(editor);
  root.addChild(hintBar);
  tui.addChild(root);
  tui.setFocus(editor);

  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(getSlashCommands(), process.cwd()),
  );

  // --- Status management ---

  let activityStatus = "idle";
  let lastCtrlCAt = 0;
  let statusText: Text | null = null;
  let statusLoader: Loader | null = null;
  let statusStartedAt: number | null = null;
  let statusTimer: NodeJS.Timeout | null = null;

  const formatElapsed = (startMs: number) => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  const ensureStatusText = () => {
    if (statusText) return;
    statusContainer.clear();
    statusLoader?.stop();
    statusLoader = null;
    statusText = new Text("", 1, 0);
    statusContainer.addChild(statusText);
  };

  const ensureStatusLoader = () => {
    if (statusLoader) return;
    statusContainer.clear();
    statusText = null;
    statusLoader = new Loader(
      tui,
      (spinner) => theme.accent(spinner),
      (text) => theme.bold(theme.accentSoft(text)),
      "",
    );
    statusContainer.addChild(statusLoader);
  };

  const renderStatus = () => {
    const isBusy = activityStatus.startsWith("thinking") ||
      activityStatus.startsWith("running tool") ||
      activityStatus.startsWith("responding") ||
      activityStatus.startsWith("subagent") ||
      activityStatus.startsWith("compacting");
    if (isBusy) {
      if (!statusStartedAt) statusStartedAt = Date.now();
      ensureStatusLoader();
      if (!statusTimer) {
        statusTimer = setInterval(() => {
          if (!statusStartedAt) return;
          const elapsed = formatElapsed(statusStartedAt);
          statusLoader?.setMessage(`${activityStatus} | ${elapsed}`);
        }, 1000);
      }
      statusLoader?.setMessage(activityStatus);
    } else {
      statusStartedAt = null;
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      statusLoader?.stop();
      statusLoader = null;
      if (activityStatus !== "idle") {
        ensureStatusText();
        statusText?.setText(theme.dim(activityStatus));
      } else {
        statusContainer.clear();
        statusText = null;
      }
    }
  };

  const setActivity = (text: string) => {
    activityStatus = text;
    renderStatus();
    tui.requestRender();
  };

  const updateHint = () => {
    const usage = getSessionUsage(state.sid);
    const parts: string[] = [
      `? for shortcuts`,
      state.currentModel,
      state.config.provider,
      state.currentSdk === "cursor" ? "cursor-sdk" : "claude-sdk",
    ];
    if (usage.calls > 0) {
      parts.push(`${formatTokens(usage.totalInput + usage.totalOutput)} tokens`);
    }
    hintBar.setHint(parts.join("  ·  "));
  };

  const updateHeader = () => { /* replaced by welcome screen */ };
  const updateFooter = () => { updateHint(); };

  // --- Overlays ---

  const openOverlay = (component: any) => { tui.showOverlay(component); };
  const closeOverlay = () => { tui.hideOverlay(); tui.setFocus(editor); };

  const openModelSelector = async () => {
    const { resolvePreset, fetchOpenRouterModels } = await import("../core/models.js");
    const preset = resolvePreset(state.config.provider, state.config.baseUrl);
    let models = [...preset.models];

    // For OpenRouter: fetch live list but keep curated presets at top
    const isOpenRouter = state.config.baseUrl?.includes("openrouter");
    if (isOpenRouter) {
      chatLog.addSystem("Fetching models from OpenRouter...");
      tui.requestRender();
      const live = await fetchOpenRouterModels(state.config.apiKey);
      if (live.length > 0) {
        const presetSet = new Set(preset.models);
        const rest = live.map(m => m.id).filter(id => !presetSet.has(id));
        models = [...preset.models, ...rest];
      }
    }

    if (!models.includes(state.currentModel)) {
      models.unshift(state.currentModel);
    }

    const items = models.map((m) => {
      const isCurrent = m === state.currentModel;
      const slash = m.indexOf("/");
      const shortName = slash > 0 ? m.slice(slash + 1) : m;
      const provider = slash > 0 ? m.slice(0, slash) : "";
      return {
        value: m,
        label: isCurrent ? `✓ ${shortName}` : `  ${shortName}`,
        description: isCurrent ? `${provider} (current)` : provider,
      };
    });

    const list = new SelectList(items, 15, selectListTheme);
    list.onSelect = async (item) => {
      closeOverlay();
      if (item.value === state.currentModel) return;
      wsSend({ type: "model.switch", model: item.value, thinking: state.currentThinking });
      saveConfig({ model: item.value });
      state.config = loadConfig();
      state.currentModel = item.value;
      chatLog.addSystem(`Switched to ${item.value}`);
      updateHeader();
      updateFooter();
      tui.requestRender();
    };
    list.onCancel = () => closeOverlay();
    openOverlay(list);
  };

  const openSessionSelector = () => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      chatLog.addSystem("No sessions.");
      tui.requestRender();
      return;
    }

    const items = sessions.map((s) => {
      const date = new Date(s.createdAt).toLocaleString();
      const displayLabel = s.label ? `${s.id} (${s.label})` : s.id;
      return { value: s.id, label: displayLabel, description: `${s.model} · ${date}` };
    });

    const list = new SelectList(items, 9, selectListTheme);
    list.onSelect = (item) => {
      closeOverlay();
      state.sid = item.value;
      state.sdkSessionId = undefined;
      state.messages = loadMessages(state.sid);
      chatLog.clearAll();
      if (state.messages.length > 0) {
        for (const m of state.messages) {
          if (m.role === "user") chatLog.addUser(m.content);
          else if (m.role === "assistant") chatLog.finalizeAssistant(m.content);
        }
      }
      chatLog.addSystem(`Switched to session: ${state.sid}`);
      updateHeader();
      updateFooter();
      tui.requestRender();
    };
    list.onCancel = () => closeOverlay();
    openOverlay(list);
  };

  // --- Shell execution ---

  const runShellCommand = (cmd: string) => {
    const command = cmd.slice(1).trim();
    if (!command) return;
    chatLog.addSystem(`$ ${command}`);
    setActivity("running shell");
    execFile("bash", ["-c", command], {
      cwd: process.cwd(), timeout: 30_000, maxBuffer: 1024 * 1024,
    }, (_err, stdout, stderr) => {
      const out = (stdout ?? "").slice(0, 40_000);
      const err = (stderr ?? "").slice(0, 10_000);
      chatLog.addSystem((err ? `${out}\n${err}` : out) || "(no output)");
      setActivity("idle");
      tui.requestRender();
    });
  };

  // --- Build context ---

  const ctx: TuiCtx = {
    state, tui, chatLog, editor, hintBar, ws, wsSend,
    setActivity, updateHeader, updateFooter, updateHint,
    openOverlay, closeOverlay,
    selectListTheme,
    openModelSelector, openSessionSelector,
  };

  // --- Gateway WS events ---

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleWsMessage(ctx, msg);
  });

  ws.on("close", () => {
    chatLog.addSystem("Gateway connection lost.");
    setActivity("disconnected");
    tui.requestRender();
  });

  // --- Editor events ---

  editor.onSubmit = (text: string) => {
    const raw = text;
    const value = raw.trim();
    editor.setText("");
    if (!value) return;
    editor.addToHistory(value);

    // Agent creation flow intercept
    if (state.agentCreation && !value.startsWith("/")) {
      if (handleAgentCreation(ctx, value)) return;
    }

    if (raw.startsWith("!") && raw !== "!") {
      runShellCommand(raw);
      return;
    }

    if (value.startsWith("/")) {
      void handleCommand(ctx, value);
      return;
    }

    // Send message to gateway
    chatLog.addUser(value);
    setActivity("thinking");
    state.toolCounter = 0;
    state.pendingMessage = value;
    wsSend({
      type: "chat",
      message: value,
      session: state.sid,
      sdk: state.currentSdk,
      ...(state.sdkSessionId && { sdkSessionId: state.sdkSessionId }),
    });
  };

  editor.onEscape = () => {
    wsSend({ type: "abort" });
    setActivity("aborting...");
  };

  editor.onCtrlC = () => {
    if (editor.getText().trim().length > 0) {
      editor.setText("");
      setActivity("cleared input");
      tui.requestRender();
      return;
    }
    const now = Date.now();
    if (now - lastCtrlCAt < 1000) {
      tui.stop();
      ws.close();
      process.exit(0);
    }
    lastCtrlCAt = now;
    setActivity("press ctrl+c again to exit");
  };

  editor.onCtrlD = () => { tui.stop(); ws.close(); process.exit(0); };
  editor.onCtrlO = () => {
    state.toolsExpanded = !state.toolsExpanded;
    chatLog.setToolsExpanded(state.toolsExpanded);
    setActivity(state.toolsExpanded ? "tools expanded" : "tools collapsed");
  };
  editor.onCtrlL = () => openModelSelector();
  editor.onCtrlP = () => openSessionSelector();

  // --- Init ---

  updateHint();
  setActivity("idle");

  // Detect SDK from existing session
  if (opts.session) {
    const meta = getSessionMeta(opts.session);
    if (meta?.sdk) state.currentSdk = meta.sdk;
  }

  if (state.messages.length > 0) {
    for (const m of state.messages) {
      if (m.role === "user") chatLog.addUser(m.content);
      else if (m.role === "assistant") chatLog.finalizeAssistant(m.content);
    }
  } else {
    const sessions = listSessions();
    const welcome = buildWelcomeScreen({
      version: VERSION,
      userName: process.env.USER ?? process.env.USERNAME,
      model: state.currentModel,
      effort: state.config.effort,
      provider: state.config.provider,
      cwd: process.cwd(),
      sessions,
      thinking: state.currentThinking,
      sdk: state.currentSdk,
    }, process.stdout.columns ?? 120);
    chatLog.addChild(welcome);
  }

  tui.start();
  tui.requestRender();

  await new Promise<void>((resolve) => {
    process.once("exit", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}
