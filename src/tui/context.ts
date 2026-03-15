// Shared TUI context — passed to extracted modules

import type { TUI, SelectListTheme } from "@mariozechner/pi-tui";
import type { WebSocket } from "ws";
import type { Config } from "../core/config.js";
import type { Message } from "../core/types.js";
import type { ChatLog } from "./components/chat-log.js";
import type { CustomEditor } from "./components/custom-editor.js";
import type { HintBar } from "./components/hint-bar.js";

export type AgentStep = "id" | "name" | "model" | "prompt" | "token";

export interface TuiState {
  config: Config;
  sid: string;
  messages: Message[];
  currentModel: string;
  currentThinking: string;
  currentEffort: string;
  sdkSessionId?: string;
  systemPrompt: string;
  toolsExpanded: boolean;
  toolCounter: number;
  pendingMessage: string | null;
  isThinking: boolean;
  agentCreation: { step: AgentStep; data: Record<string, string> } | null;
}

export interface TuiCtx {
  state: TuiState;
  tui: TUI;
  chatLog: ChatLog;
  editor: CustomEditor;
  hintBar: HintBar;
  ws: WebSocket;
  wsSend: (data: unknown) => void;
  setActivity: (text: string) => void;
  updateHeader: () => void;
  updateFooter: () => void;
  updateHint: () => void;
  openOverlay: (component: any) => void;
  closeOverlay: () => void;
  selectListTheme: SelectListTheme;
  openModelSelector: () => void | Promise<void>;
  openSessionSelector: () => void;
}
