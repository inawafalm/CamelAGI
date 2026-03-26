// Directory browser: navigate folders via Telegram inline keyboards
//
// Shows directories as buttons. Click to enter, back to go up, select to confirm.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";

interface BrowseState {
  currentDir: string;
  messageId?: number;
  onSelect: (dir: string) => void;
}

const states = new Map<number, BrowseState>();

/** List subdirectories in a path (max 8, alphabetical, skip hidden) */
function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 8);
  } catch {
    return [];
  }
}

/** Shorten path for display (replace home with ~) */
function displayPath(dir: string): string {
  const home = os.homedir();
  return dir.startsWith(home) ? "~" + dir.slice(home.length) : dir;
}

/** Build the inline keyboard for a directory */
function buildKeyboard(dir: string): InlineKeyboard {
  const dirs = listDirs(dir);
  const kb = new InlineKeyboard();

  // Folder buttons (2 per row)
  for (let i = 0; i < dirs.length; i++) {
    kb.text(`📁 ${dirs[i]}`, `browse:${dirs[i]}`);
    if (i % 2 === 1 && i + 1 < dirs.length) kb.row();
  }

  // Back + Select row
  kb.row();
  if (dir !== "/" && dir !== os.homedir()) {
    kb.text("⬅ Back", "browse:__back__");
  }
  kb.text("✓ Select this folder", "browse:__select__");

  return kb;
}

/** Start browsing from a directory */
export async function startBrowse(
  chatId: number,
  api: Bot["api"],
  startDir: string,
  onSelect: (dir: string) => void,
): Promise<void> {
  const dir = startDir.startsWith("~") ? startDir.replace("~", os.homedir()) : startDir;
  const state: BrowseState = { currentDir: dir, onSelect };

  const kb = buildKeyboard(dir);
  const sent = await api.sendMessage(chatId, `📂 Select working directory:\n${displayPath(dir)}`, {
    reply_markup: kb,
  });
  state.messageId = sent.message_id;
  states.set(chatId, state);
}

/** Handle a browse callback. Returns true if consumed. */
export async function handleBrowseCallback(
  chatId: number,
  value: string,
  api: Bot["api"],
): Promise<boolean> {
  const state = states.get(chatId);
  if (!state) return false;

  if (value === "__select__") {
    states.delete(chatId);
    // Edit the message to show final selection
    if (state.messageId) {
      try {
        await api.editMessageText(chatId, state.messageId, `✓ Working directory: ${displayPath(state.currentDir)}`);
      } catch {}
    }
    state.onSelect(state.currentDir);
    return true;
  }

  if (value === "__back__") {
    state.currentDir = path.dirname(state.currentDir);
  } else {
    const newDir = path.join(state.currentDir, value);
    if (fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()) {
      state.currentDir = newDir;
    }
  }

  // Update the message with new directory listing
  const kb = buildKeyboard(state.currentDir);
  if (state.messageId) {
    try {
      await api.editMessageText(chatId, state.messageId, `📂 Select working directory:\n${displayPath(state.currentDir)}`, {
        reply_markup: kb,
      });
    } catch {}
  }

  return true;
}

/** Check if a browse session is active */
export function isBrowsing(chatId: number): boolean {
  return states.has(chatId);
}

/** Cancel an active browse session */
export function cancelBrowse(chatId: number): void {
  states.delete(chatId);
}
