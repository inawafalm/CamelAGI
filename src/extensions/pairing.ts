// Telegram pairing: approval flow for new users
// Unauthorized users get a pairing code, admin approves, user gets access.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { paths, saveConfig, loadConfig } from "../core/config.js";

const PAIRING_FILE = path.join(paths.configDir, "pairing.json");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1
const CODE_LENGTH = 6;
const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING = 10;

export type PairingStatus = "pending" | "completed";

export interface PairingRequest {
  code: string;
  userId: number;
  username?: string;
  firstName?: string;
  agentId: string;
  chatId: number;
  requestedAt: number;
  status: PairingStatus;
}

function loadRequests(): PairingRequest[] {
  try {
    if (!fs.existsSync(PAIRING_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PAIRING_FILE, "utf-8"));
    return raw.map((r: any) => ({ ...r, status: r.status ?? "pending" }));
  } catch {
    return [];
  }
}

function saveRequests(requests: PairingRequest[]): void {
  fs.mkdirSync(path.dirname(PAIRING_FILE), { recursive: true });
  fs.writeFileSync(PAIRING_FILE, JSON.stringify(requests, null, 2));
}

function generateCode(existing: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const bytes = randomBytes(CODE_LENGTH);
    const code = Array.from(bytes).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    if (!existing.has(code)) return code;
  }
  throw new Error("Failed to generate unique pairing code");
}

/** Prune expired requests */
function prune(requests: PairingRequest[]): PairingRequest[] {
  const now = Date.now();
  return requests.filter((r) => now - r.requestedAt < TTL_MS);
}

/** Check if user already has a pending request for this agent */
export function hasPendingRequest(userId: number, agentId: string): PairingRequest | undefined {
  const requests = prune(loadRequests());
  return requests.find((r) => r.userId === userId && r.agentId === agentId && r.status === "pending");
}

/** Create a new pairing request. Returns the request with code. */
export function createPairingRequest(
  userId: number,
  agentId: string,
  chatId: number,
  username?: string,
  firstName?: string,
): PairingRequest {
  let requests = prune(loadRequests());

  // If user already has a pending request for this agent, return it
  const existing = requests.find((r) => r.userId === userId && r.agentId === agentId);
  if (existing) return existing;

  // Cap pending requests
  if (requests.length >= MAX_PENDING) {
    requests = requests.slice(-MAX_PENDING + 1);
  }

  const codes = new Set(requests.map((r) => r.code));
  const request: PairingRequest = {
    code: generateCode(codes),
    userId,
    username,
    firstName,
    agentId,
    chatId,
    requestedAt: Date.now(),
    status: "pending",
  };

  requests.push(request);
  saveRequests(requests);
  return request;
}

/** Find a request by code */
export function findByCode(code: string): PairingRequest | undefined {
  const requests = prune(loadRequests());
  return requests.find((r) => r.code === code.toUpperCase());
}

/** List all pending requests */
export function listPendingRequests(): PairingRequest[] {
  const requests = prune(loadRequests());
  saveRequests(requests); // persist pruned list
  return requests.filter((r) => r.status === "pending");
}

/**
 * Approve a pairing request: add user to allowedUsers immediately and remove request.
 */
export function approveRequest(code: string): PairingRequest | undefined {
  const requests = prune(loadRequests());
  const idx = requests.findIndex((r) => r.code === code.toUpperCase());
  if (idx === -1) return undefined;

  const request = requests[idx];
  if (request.status !== "pending") return undefined;

  // Add to allowedUsers immediately
  addUserToAllowedList(request);

  // Remove request
  requests.splice(idx, 1);
  saveRequests(requests);

  return request;
}

/** Add user to the appropriate allowedUsers list in config */
function addUserToAllowedList(request: PairingRequest): void {
  const config = loadConfig();
  const agentId = request.agentId;

  if (agentId === "telegram") {
    const current = config.telegram.allowedUsers ?? [];
    if (!current.includes(request.userId)) {
      saveConfig({ telegram: { ...config.telegram, allowedUsers: [...current, request.userId] } });
      console.log(`[pairing] Added userId=${request.userId} to telegram.allowedUsers`);
    }
  } else {
    const agent = config.agents[agentId];
    if (agent?.telegram) {
      const current = agent.telegram.allowedUsers ?? [];
      if (!current.includes(request.userId)) {
        const agents = { ...config.agents };
        agents[agentId] = {
          ...agent,
          telegram: { ...agent.telegram, allowedUsers: [...current, request.userId] },
        };
        saveConfig({ agents });
        console.log(`[pairing] Added userId=${request.userId} to agents.${agentId}.telegram.allowedUsers`);
      }
    }
  }
}

/** Deny a pairing request: just remove it */
export function denyRequest(code: string): PairingRequest | undefined {
  let requests = prune(loadRequests());
  const idx = requests.findIndex((r) => r.code === code.toUpperCase());
  if (idx === -1) return undefined;

  const [request] = requests.splice(idx, 1);
  saveRequests(requests);
  return request;
}
