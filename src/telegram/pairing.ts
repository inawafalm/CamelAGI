// Telegram pairing: approval flow for new users
// Unauthorized users get a pairing code, admin approves via macOS app,
// then user must enter a 5-digit OTP in chat to complete verification.

import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { paths, saveConfig, loadConfig } from "../core/config.js";

const PAIRING_FILE = path.join(paths.configDir, "pairing.json");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1
const CODE_LENGTH = 6;
const TTL_MS = 60 * 60 * 1000; // 1 hour
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes for OTP entry
const MAX_PENDING = 10;
const MAX_OTP_ATTEMPTS = 5;

export type PairingStatus = "pending" | "otp_pending" | "completed";

export interface PairingRequest {
  code: string;
  userId: number;
  username?: string;
  firstName?: string;
  agentId: string;
  chatId: number;
  requestedAt: number;
  status: PairingStatus;
  otp?: string;
  otpCreatedAt?: number;
  otpAttempts?: number;
}

function loadRequests(): PairingRequest[] {
  try {
    if (!fs.existsSync(PAIRING_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PAIRING_FILE, "utf-8"));
    // Migrate old requests without status
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

/** Generate a 5-digit OTP */
function generateOtp(): string {
  return String(randomInt(10000, 99999));
}

/** Prune expired requests */
function prune(requests: PairingRequest[]): PairingRequest[] {
  const now = Date.now();
  return requests.filter((r) => {
    // OTP-pending requests expire after OTP_TTL_MS from OTP creation
    if (r.status === "otp_pending" && r.otpCreatedAt) {
      return now - r.otpCreatedAt < OTP_TTL_MS;
    }
    // Regular requests expire after TTL_MS
    return now - r.requestedAt < TTL_MS;
  });
}

/** Check if user already has a pending request for this agent */
export function hasPendingRequest(userId: number, agentId: string): PairingRequest | undefined {
  const requests = prune(loadRequests());
  return requests.find((r) => r.userId === userId && r.agentId === agentId);
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

/** List all pending requests (status: pending or otp_pending) */
export function listPendingRequests(): PairingRequest[] {
  const requests = prune(loadRequests());
  saveRequests(requests); // persist pruned list
  return requests.filter((r) => r.status === "pending" || r.status === "otp_pending");
}

/**
 * Approve a pairing request: generate OTP, set status to otp_pending.
 * Does NOT add user to allowedUsers yet — that happens after OTP verification.
 * Returns the request with OTP for display in the macOS app.
 */
export function approveRequest(code: string): (PairingRequest & { otp: string }) | undefined {
  const requests = prune(loadRequests());
  const idx = requests.findIndex((r) => r.code === code.toUpperCase());
  if (idx === -1) return undefined;

  const request = requests[idx];
  if (request.status !== "pending") return undefined;

  const otp = generateOtp();
  request.status = "otp_pending";
  request.otp = otp;
  request.otpCreatedAt = Date.now();
  saveRequests(requests);

  return request as PairingRequest & { otp: string };
}

export type OtpResult =
  | { ok: true; request: PairingRequest }
  | { ok: false; reason: "not_found" | "expired" | "locked" | "wrong" };

/**
 * Verify OTP from a Telegram user. If correct, add to allowedUsers and remove request.
 * Returns a result object with the reason for failure.
 */
export function verifyOtp(userId: number, agentId: string, otpInput: string): OtpResult {
  const requests = prune(loadRequests());
  const idx = requests.findIndex(
    (r) => r.userId === userId && r.agentId === agentId && r.status === "otp_pending",
  );
  if (idx === -1) return { ok: false, reason: "not_found" };

  const request = requests[idx];

  // Check if expired
  if (request.otpCreatedAt && Date.now() - request.otpCreatedAt >= OTP_TTL_MS) {
    requests.splice(idx, 1);
    saveRequests(requests);
    return { ok: false, reason: "expired" };
  }

  // Check brute-force lock
  if ((request.otpAttempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    requests.splice(idx, 1);
    saveRequests(requests);
    return { ok: false, reason: "locked" };
  }

  // Check OTP
  if (request.otp !== otpInput.trim()) {
    request.otpAttempts = (request.otpAttempts ?? 0) + 1;
    saveRequests(requests);
    return { ok: false, reason: "wrong" };
  }

  // OTP matches — add to allowedUsers FIRST (atomic: user gets access even if cleanup fails)
  addUserToAllowedList(request);

  // Then remove request
  request.status = "completed";
  requests.splice(idx, 1);
  saveRequests(requests);

  return { ok: true, request };
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
    } else {
      console.error(`[pairing] FAILED: agent=${agentId} has no telegram config — user NOT added!`);
    }
  }

  // Verify the write succeeded by reading back
  try {
    const verify = loadConfig();
    const list = agentId === "telegram"
      ? verify.telegram.allowedUsers
      : verify.agents[agentId]?.telegram?.allowedUsers ?? [];
    console.log(`[pairing] Verify: allowedUsers for ${agentId} = [${list.join(", ")}]`);
  } catch (err) {
    console.error(`[pairing] Verify read-back failed:`, err);
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
