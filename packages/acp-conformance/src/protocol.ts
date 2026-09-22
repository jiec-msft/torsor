import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";

import { fail, record } from "./facts.js";

const schema: unknown = createRequire(import.meta.url)("@agentclientprotocol/sdk/schema/schema.json");
if (!record(schema)) throw new Error("Published ACP schema is unavailable.");
const validator = new Ajv2020({ strict: false, validateFormats: false });
validator.addSchema(schema, "acp-v1");

const definitions: Record<string, { params: string; result?: string }> = {
  initialize: { params: "InitializeRequest", result: "InitializeResponse" },
  "session/new": { params: "NewSessionRequest", result: "NewSessionResponse" },
  "session/prompt": { params: "PromptRequest", result: "PromptResponse" },
  "session/cancel": { params: "CancelNotification" },
  "session/update": { params: "SessionNotification" },
  "session/request_permission": { params: "RequestPermissionRequest", result: "RequestPermissionResponse" },
};

export function validatePayload(method: string, part: "params" | "result", value: unknown): void {
  const definition = definitions[method]?.[part];
  if (!definition) return;
  const check = validator.getSchema(`acp-v1#/$defs/${definition}`);
  if (!check) throw new Error("Published ACP method definition is unavailable.");
  if (!check(value)) fail("protocol_result", "Payload does not match the pinned ACP method schema.");
}
