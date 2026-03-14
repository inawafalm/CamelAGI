// Assistant message component (from OpenClaw)

import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme.js";

export class AssistantMessageComponent extends Container {
  private body: Markdown;
  private currentText: string;

  constructor(text: string) {
    super();
    this.currentText = text;
    this.body = new Markdown(text, 1, 0, markdownTheme, {
      color: (line) => theme.assistantText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.currentText = text;
    this.body.setText(text);
  }

  /** Append incremental text (for streaming) */
  appendText(text: string) {
    this.currentText += text;
    this.body.setText(this.currentText);
  }
}
