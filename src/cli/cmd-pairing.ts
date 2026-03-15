// CLI command: camelagi pairing — manage pairing requests from the terminal

import { register } from "./registry.js";
import { listPendingRequests, approveRequest, denyRequest } from "../telegram/pairing.js";
import readline from "node:readline";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

register({
  name: "pairing",
  description: "List and approve/deny pending pairing requests",
  async run() {
    const requests = listPendingRequests();

    if (requests.length === 0) {
      console.log("  No pending pairing requests.");
      return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    for (const r of requests) {
      const userLabel = r.username ? `@${r.username}` : r.firstName ?? String(r.userId);

      console.log(`\n  Request: ${r.code}`);
      console.log(`  User:    ${userLabel} (${r.userId})`);
      console.log(`  Agent:   ${r.agentId}`);

      const answer = await ask(rl, `\n  Approve? (y/n): `);
      if (answer.trim().toLowerCase() === "y") {
        const approved = approveRequest(r.code);
        if (approved) {
          console.log(`  ✓ Approved. User now has access.`);
        } else {
          console.log(`  ✗ Request expired or already handled.`);
        }
      } else {
        denyRequest(r.code);
        console.log(`  ✗ Denied.`);
      }
    }

    rl.close();
  },
});
