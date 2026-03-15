// TUI WebSocket message handler — processes gateway events

import { SelectList } from "@mariozechner/pi-tui";
import { formatUsageSummary } from "../usage.js";
import type { TuiCtx } from "./context.js";

export function handleWsMessage(ctx: TuiCtx, msg: any): void {
  const { state, chatLog, tui, setActivity, updateHeader, updateFooter, openOverlay, closeOverlay, wsSend } = ctx;

  switch (msg.type) {
    case "init":
      state.sdkSessionId = msg.sessionId;
      break;

    case "stream_text":
      state.isThinking = false;
      chatLog.appendAssistantText(msg.text);
      setActivity("responding");
      break;

    case "thinking":
      if (msg.state === "start") {
        state.isThinking = true;
        setActivity("thinking deeply...");
      } else {
        state.isThinking = false;
      }
      break;

    case "thinking_delta":
      setActivity("thinking deeply...");
      break;

    case "chunk":
      chatLog.updateAssistant(msg.text);
      setActivity("thinking");
      break;

    case "approval_request": {
      const approvalId = msg.id as string;
      const toolName = msg.toolName as string;
      const preview = msg.preview as string;

      setActivity(`awaiting approval: ${toolName}`);
      chatLog.addSystem(`${toolName}: ${preview}`);

      const items = [
        { value: "allow-once", label: "Allow once", description: "Run this time only" },
        { value: "allow-always", label: "Always allow", description: "Add to allowlist" },
        { value: "deny", label: "Deny", description: "Block this tool call" },
      ];

      const approvalList = new SelectList(items, 5, ctx.selectListTheme);
      approvalList.onSelect = (item) => {
        closeOverlay();
        wsSend({ type: "approval.decide", id: approvalId, decision: item.value });
        chatLog.addSystem(`-> ${item.label}`);
        setActivity("thinking");
        tui.requestRender();
      };
      approvalList.onCancel = () => {
        closeOverlay();
        wsSend({ type: "approval.decide", id: approvalId, decision: "deny" });
        chatLog.addSystem("-> Denied (cancelled)");
        setActivity("thinking");
        tui.requestRender();
      };
      openOverlay(approvalList);
      tui.requestRender();
      break;
    }

    case "approval_resolved":
      break;

    case "tool_call": {
      const id = msg.id ?? `tool-${++state.toolCounter}`;
      chatLog.startTool(id, msg.name, msg.args);
      setActivity(`running tool: ${msg.name}`);
      break;
    }

    case "tool_result": {
      const id = msg.id ?? `tool-${state.toolCounter}`;
      chatLog.finishTool(id, msg.preview);
      setActivity("thinking");
      break;
    }

    case "subagent_start":
      chatLog.addSystem(`Subagent started: ${msg.agentId}`);
      setActivity(`subagent: ${msg.agentId}`);
      break;

    case "subagent_progress": {
      const parts = [`subagent: ${msg.agentId}`];
      if (msg.toolCount != null) parts.push(`${msg.toolCount} tools`);
      if (msg.duration != null) parts.push(`${msg.duration}s`);
      setActivity(parts.join(" | "));
      break;
    }

    case "subagent_done":
      chatLog.addSystem(`Subagent completed: ${msg.agentId}`);
      setActivity("thinking");
      break;

    case "usage":
      updateFooter();
      break;

    case "done": {
      state.isThinking = false;
      chatLog.finalizeAssistant(msg.response || "(no response)");

      if (msg.sdkSessionId) {
        state.sdkSessionId = msg.sdkSessionId;
      }

      if (state.pendingMessage) {
        state.messages.push({ role: "user", content: state.pendingMessage });
        state.pendingMessage = null;
      }
      if (msg.response) {
        state.messages.push({ role: "assistant", content: msg.response });
      }

      updateFooter();
      setActivity("idle");
      break;
    }

    case "retry":
      chatLog.addSystem(`Retrying (${msg.kind}, attempt ${msg.attempt + 1})...`);
      break;

    case "compacted":
      chatLog.addSystem("(context compacted)");
      break;

    case "error":
      state.isThinking = false;
      chatLog.addSystem(`Error: ${msg.message}`);
      setActivity("error");
      break;

    case "aborted":
      state.isThinking = false;
      chatLog.addSystem("Request aborted.");
      setActivity("aborted");
      break;

    case "model.switched":
      state.currentModel = msg.model;
      state.currentThinking = msg.thinking;
      if (msg.effort) state.currentEffort = msg.effort;
      state.sdkSessionId = undefined;
      updateHeader();
      updateFooter();
      break;

    case "sessions":
      break;

    case "status":
      chatLog.addSystem(
        [
          `Session: ${msg.session}`,
          `Model: ${msg.model}`,
          `Provider: ${msg.provider}`,
          `Messages: ${msg.messageCount}`,
          `History: ~${msg.historyTokens?.toLocaleString()} tokens`,
          msg.usage ? `Token usage: ${formatUsageSummary(msg.usage)} (${msg.usage.calls} API calls)` : null,
          `Active runs: ${msg.activeRuns}`,
          state.sdkSessionId ? `SDK session: ${state.sdkSessionId.slice(0, 12)}...` : null,
        ].filter(Boolean).join("\n"),
      );
      break;
  }

  tui.requestRender();
}
