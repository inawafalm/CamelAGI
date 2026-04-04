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

function teeWrite(original: typeof process.stdout.write): typeof process.stdout.write {
  return function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
    logStream.write(chunk as string | Uint8Array);
    return (original as Function).call(this, chunk, ...rest) as boolean;
  } as typeof process.stdout.write;
}
process.stdout.write = teeWrite(origStdoutWrite);
process.stderr.write = teeWrite(origStderrWrite);

const port = parseInt(process.env.PORT ?? "18305", 10);
const host = process.env.HOST ?? "127.0.0.1";

await startServer({ port, host, cron: true, boot: false, channels: true });
