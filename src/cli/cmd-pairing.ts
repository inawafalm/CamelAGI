// CLI command: camelagi pairing — manage pairing requests from the terminal

import { register } from "./registry.js";
import { listPendingRequests, approveRequest, denyRequest } from "../extensions/pairing.js";

register({
  name: "pairing",
  description: "List and approve/deny pending pairing requests",
  async run() {
    const p = await import("@clack/prompts");
    const requests = listPendingRequests();

    if (requests.length === 0) {
      p.log.info("No pending pairing requests.");
      return;
    }

    for (const r of requests) {
      const userLabel = r.username ? `@${r.username}` : r.firstName ?? String(r.userId);

      p.log.step(`Request: ${r.code}`);
      p.log.info(`User: ${userLabel} (${r.userId})`);
      p.log.info(`Agent: ${r.agentId}`);

      const ok = await p.confirm({ message: `Approve ${userLabel}?` });
      if (p.isCancel(ok)) { p.cancel("Cancelled."); return; }

      if (ok) {
        const approved = approveRequest(r.code);
        if (approved) {
          p.log.success(`Approved. ${userLabel} now has access.`);
        } else {
          p.log.warn("Request expired or already handled.");
        }
      } else {
        denyRequest(r.code);
        p.log.info("Denied.");
      }
    }
  },
});
