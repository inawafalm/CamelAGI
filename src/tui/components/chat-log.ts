// Chat log: scrollable container of messages (adapted from OpenClaw)

import type { Component } from "@mariozechner/pi-tui";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export class ChatLog extends Container {
  private readonly maxComponents: number;
  private toolById = new Map<string, ToolExecutionComponent>();
  private currentAssistant: AssistantMessageComponent | null = null;
  private toolsExpanded = false;

  constructor(maxComponents = 180) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
  }

  private pruneOverflow() {
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) return;
      this.removeChild(oldest);
    }
  }

  private append(component: Component) {
    this.addChild(component);
    this.pruneOverflow();
  }

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.currentAssistant = null;
  }

  addSystem(text: string) {
    this.append(new Spacer(1));
    this.append(new Text(theme.system(text), 1, 0));
  }

  addUser(text: string) {
    this.append(new UserMessageComponent(text));
  }

  startAssistant(text: string) {
    const component = new AssistantMessageComponent(text);
    this.currentAssistant = component;
    this.append(component);
    return component;
  }

  updateAssistant(text: string) {
    if (!this.currentAssistant) {
      this.startAssistant(text);
      return;
    }
    this.currentAssistant.setText(text);
  }

  /** Append incremental text to the current assistant message (for streaming) */
  appendAssistantText(text: string) {
    if (!this.currentAssistant) {
      this.startAssistant(text);
      return;
    }
    this.currentAssistant.appendText(text);
  }

  finalizeAssistant(text: string) {
    if (this.currentAssistant) {
      this.currentAssistant.setText(text);
      this.currentAssistant = null;
      return;
    }
    this.append(new AssistantMessageComponent(text));
  }

  startTool(id: string, toolName: string, args: unknown) {
    const existing = this.toolById.get(id);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(id, component);
    this.append(component);
    return component;
  }

  finishTool(id: string, result: string, isError = false) {
    const existing = this.toolById.get(id);
    if (!existing) return;
    existing.setResult(result, { isError });
  }

  setToolsExpanded(expanded: boolean) {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) {
      tool.setExpanded(expanded);
    }
  }
}
