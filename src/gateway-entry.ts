// Standalone entry point for the bundled gateway.
// Used by the Camel macOS app to spawn the gateway process.

import fs from "node:fs";
import { startServer } from "./serve.js";

// Tee stdout/stderr to a log file so we can debug from the Camel app
const debugLog = `${process.env.HOME}/.camelagi/logs/gateway-debug.log`;
fs.mkdirSync(`${process.env.HOME}/.camelagi/logs`, { recursive: true });
const logStream = fs.createWriteStream(debugLog, { flags: "a" });
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = ((chunk: any, ...args: any[]) => { logStream.write(chunk); return origStdoutWrite(chunk, ...args); }) as any;
process.stderr.write = ((chunk: any, ...args: any[]) => { logStream.write(chunk); return origStderrWrite(chunk, ...args); }) as any;

const port = parseInt(process.env.PORT ?? "18305", 10);
const host = process.env.HOST ?? "127.0.0.1";

await startServer({ port, host, cron: true, boot: false, channels: true });
