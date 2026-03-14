// Hint bar component — shows keyboard shortcuts below the editor

import { Text } from "@mariozechner/pi-tui";
import chalk from "chalk";

const dim = (s: string) => chalk.hex("#7B7F87")(s);

export class HintBar extends Text {
  constructor() {
    super(dim("  ? for shortcuts"), 0, 0);
  }

  setHint(text: string) {
    this.setText(dim(`  ${text}`));
  }
}
