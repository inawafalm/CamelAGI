// Bot approval: admin must approve before a new agent's Telegram bot starts polling.
// When a new agent with a bot token is created, it goes into pending state.
// Admin approves via inline button in admin bot or macOS app → bot starts.

import fs from "node:fs";
import path from "node:path";
import { paths } from "../core/config.js";

const APPROVAL_FILE = path.join(paths.configDir, "bot-approvals.json");

export interface BotApproval {
  agentId: string;
  agentName: string;
  botToken: string;
  botUsername?: string;
  model?: string;
  requestedAt: number;
}

function loadApprovals(): BotApproval[] {
  try {
    if (!fs.existsSync(APPROVAL_FILE)) return [];
    return JSON.parse(fs.readFileSync(APPROVAL_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveApprovals(approvals: BotApproval[]): void {
  fs.mkdirSync(path.dirname(APPROVAL_FILE), { recursive: true });
  fs.writeFileSync(APPROVAL_FILE, JSON.stringify(approvals, null, 2));
}

/** Add a bot to the pending approval queue */
export function requestBotApproval(approval: BotApproval): void {
  const approvals = loadApprovals();
  // Replace if already pending for this agent
  const idx = approvals.findIndex((a) => a.agentId === approval.agentId);
  if (idx !== -1) {
    approvals[idx] = approval;
  } else {
    approvals.push(approval);
  }
  saveApprovals(approvals);
}

/** List all pending bot approvals */
export function listPendingBotApprovals(): BotApproval[] {
  return loadApprovals();
}

/** Approve a bot: remove from pending, return the approval for starting */
export function approveBotApproval(agentId: string): BotApproval | undefined {
  const approvals = loadApprovals();
  const idx = approvals.findIndex((a) => a.agentId === agentId);
  if (idx === -1) return undefined;

  const [approval] = approvals.splice(idx, 1);
  saveApprovals(approvals);
  return approval;
}

/** Deny a bot: remove from pending */
export function denyBotApproval(agentId: string): BotApproval | undefined {
  const approvals = loadApprovals();
  const idx = approvals.findIndex((a) => a.agentId === agentId);
  if (idx === -1) return undefined;

  const [approval] = approvals.splice(idx, 1);
  saveApprovals(approvals);
  return approval;
}

/** Check if an agent has a pending bot approval */
export function hasPendingBotApproval(agentId: string): boolean {
  return loadApprovals().some((a) => a.agentId === agentId);
}
