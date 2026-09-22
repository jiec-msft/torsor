import { z } from "zod";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";

import { assertJson, record, type Json } from "./facts.js";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const method = z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$/.-]{0,127}$/);
const json: z.ZodType<Json> = z.json();
const object = z.record(z.string(), json);
const fact = z.strictObject({
  path: z.string().max(256).regex(/^(?:\/(?:[^~]|~[01])*)?$/),
  equals: json.optional(),
  kind: z.enum(["object", "array", "string", "number", "boolean", "null"]).optional(),
}).refine((value) => Object.hasOwn(value, "equals") !== Object.hasOwn(value, "kind"));
const expectations = z.array(fact).max(128).default([]);
const step = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("request"), id, method, params: object.default({}) }),
  z.strictObject({ type: z.literal("response"), id, expect: expectations, errorCode: z.int().optional() }),
  z.strictObject({ type: z.literal("notification"), method, params: object.default({}) }),
  z.strictObject({ type: z.literal("update"), sessionUpdate: id, expect: expectations }),
  z.strictObject({ type: z.literal("close-stdin") }),
  z.strictObject({ type: z.literal("exit"), code: z.int().min(0).max(255) }),
]);
const action = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("reply"), result: json.optional(), errorCode: z.int().optional() })
    .refine((value) => Object.hasOwn(value, "result") !== Object.hasOwn(value, "errorCode")),
  z.strictObject({ type: z.literal("notify"), method, params: object.default({}) }),
  z.strictObject({ type: z.literal("request"), method, params: object.default({}), expect: expectations, errorCode: z.int().optional() }),
  z.strictObject({ type: z.literal("wait"), gate: id }),
  z.strictObject({ type: z.literal("release"), gate: id }),
  z.strictObject({
    type: z.literal("fault"),
    fault: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("malformed") }),
      z.strictObject({ kind: z.literal("oversized"), bytes: z.int().positive().max(8_388_608) }),
      z.strictObject({ kind: z.literal("stderr"), bytes: z.int().positive().max(8_388_608) }),
      z.strictObject({ kind: z.literal("stdout-close") }),
      z.strictObject({ kind: z.literal("stdin-close") }),
      z.strictObject({ kind: z.literal("exit"), code: z.int().min(0).max(255) }),
      z.strictObject({ kind: z.literal("hang") }),
      z.strictObject({ kind: z.literal("wire"), message: json, newline: z.boolean().default(true) }),
    ]),
  }),
]);
const bounded = (fallback: number, max: number) => z.int().positive().max(max).default(fallback);
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: id.refine((value) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value)),
  steps: z.array(step).min(1).max(128),
  limits: z.strictObject({
    frameBytes: bounded(262_144, 1_048_576),
    stdoutBytes: bounded(1_048_576, 8_388_608),
    stderrBytes: bounded(65_536, 1_048_576),
    events: bounded(2048, 16384),
    stepMs: bounded(5000, 120_000),
    runMs: bounded(30_000, 300_000),
    shutdownMs: bounded(2000, 10_000),
  }).prefault({}),
  mock: z.strictObject({
    handlers: z.array(z.strictObject({
      kind: z.enum(["request", "notification"]),
      method,
      actions: z.array(action).min(1).max(128),
    })).max(128),
    onStdinClose: z.array(action).max(128).default([]),
  }).optional(),
  expectFailure: z.enum([
    "malformed_frame", "invalid_envelope", "unexpected_response", "protocol_result",
    "protocol_state", "frame_limit", "stdout_limit", "stderr_limit", "event_limit",
    "json_depth", "partial_frame", "stdout_closed", "stdin_closed", "process_exit",
    "timeout", "rpc_error", "assertion_failed", "invalid_reference",
  ]).optional(),
});

export type Scenario = z.infer<typeof schema>;
export type Limits = Scenario["limits"];
export type MockAction = z.infer<typeof action>;

export class ConfigurationError extends Error {
  constructor(readonly paths: readonly string[], message = "Invalid scenario configuration.") {
    super(`${message} ${paths.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

export function validateScenario(value: unknown): Scenario {
  try {
    assertJson(value);
    if (Buffer.byteLength(JSON.stringify(value)) > 262_144) throw new Error("Scenario is too large.");
  } catch {
    throw new ConfigurationError(["$"], "Expected bounded JSON values.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues.map((issue) =>
      `$${issue.path.map((part) => typeof part === "number" ? `[${part}]` : `.${String(part)}`).join("")}`,
    ));
  }
  const labels = new Set<string>();
  const pending = new Set<string>();
  for (const [index, step] of parsed.data.steps.entries()) {
    if (step.type === "request") {
      if (labels.has(step.id)) throw new ConfigurationError([`$.steps[${index}].id`], "Duplicate request label.");
      labels.add(step.id);
      pending.add(step.id);
    } else if (step.type === "response") {
      if (!pending.delete(step.id)) throw new ConfigurationError([`$.steps[${index}].id`], "Response requires an outstanding request.");
    }
  }
  if (pending.size) throw new ConfigurationError(["$.steps"], "Every request requires a response step.");
  const handlers = new Set<string>();
  for (const [index, handler] of (parsed.data.mock?.handlers ?? []).entries()) {
    const key = `${handler.kind}:${handler.method}`;
    if (handlers.has(key)) throw new ConfigurationError([`$.mock.handlers[${index}]`], "Duplicate mock handler.");
    handlers.add(key);
  }
  return parsed.data;
}

export function loadScenario(text: string, options: { format: "json" | "yaml" }): Scenario {
  if (Buffer.byteLength(text) > 262_144) throw new ConfigurationError(["$"], "Scenario exceeds 256 KiB.");
  let value: unknown;
  try {
    if (options.format === "json") value = JSON.parse(text);
    else if (options.format === "yaml") {
      const document = parseDocument(text, { schema: "core", uniqueKeys: true, merge: false });
      if (document.errors.length || document.warnings.length) throw new Error("Invalid YAML.");
      visit(document, (_key, node) => {
        const coreTags = new Set(["null", "bool", "int", "float", "str", "seq", "map"].map((name) => `tag:yaml.org,2002:${name}`));
        if (isAlias(node) || (record(node) && node.tag && !coreTags.has(String(node.tag)))) {
          throw new Error("Custom tags and aliases are not supported.");
        }
        if (isMap(node)) {
          for (const item of node.items) {
            if (!isScalar(item.key) || typeof item.key.value !== "string" || item.key.value === "<<") {
              throw new Error("Only JSON object keys are supported.");
            }
          }
        }
      });
      value = document.toJS({ maxAliasCount: 0 });
    } else throw new Error("Unsupported format.");
  } catch {
    throw new ConfigurationError(["$"], "Invalid JSON-compatible scenario document.");
  }
  return validateScenario(value);
}
