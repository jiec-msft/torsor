import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const marker = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  await appendFile(marker, `${message.method}\n`);
  if (Object.hasOwn(message, "id")) {
    const result = message.method === "initialize"
      ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
      : { sessionId: "synthetic-session" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
}
