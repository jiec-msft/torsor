import { isDeepStrictEqual } from "node:util";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordValue = Record<string, unknown>;

export function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export function fail(code: string, message: string): never {
  throw new HarnessError(code, message);
}

export function assertJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 32) fail("json_depth", "JSON exceeds depth 32.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (record(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) assertJson(item, depth + 1);
    return;
  }
  fail("invalid_json", "Only finite JSON values are supported.");
}

export function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  if (!path.startsWith("/") || /~(?:[^01]|$)/.test(path)) {
    fail("invalid_reference", "Expected an RFC 6901 JSON Pointer.");
  }
  let current = value;
  for (const token of path.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      (!record(current) && !Array.isArray(current)) ||
      !Object.hasOwn(current, key)
    ) fail("assertion_failed", "JSON Pointer does not identify a value.");
    current = Reflect.get(current, key);
  }
  return current;
}

export interface Fact {
  path: string;
  equals?: Json | undefined;
  kind?: "object" | "array" | "string" | "number" | "boolean" | "null" | undefined;
}

export function assertFacts(value: unknown, facts: readonly Fact[]): void {
  for (const fact of facts) {
    const actual = pointer(value, fact.path);
    if (Object.hasOwn(fact, "equals") && !isDeepStrictEqual(actual, fact.equals)) {
      fail("assertion_failed", "JSON Pointer value differs from the configured expectation.");
    }
    const kind = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
    if (fact.kind && kind !== fact.kind) {
      fail("assertion_failed", "JSON Pointer value has an unexpected kind.");
    }
  }
}

export function resolveRefs(value: Json, workspace: string, responses: Map<string, Json>): Json {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, workspace, responses));
  if (!record(value)) return value;
  if (Object.hasOwn(value, "$ref")) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== "string") {
      fail("invalid_reference", "A reference must be a single $ref string.");
    }
    if (value.$ref === "workspace") return workspace;
    const split = value.$ref.indexOf("#");
    const source = responses.get(value.$ref.slice(0, split));
    if (split < 1 || source === undefined) fail("invalid_reference", "Reference is not bound to a consumed response.");
    const resolved = pointer(source, value.$ref.slice(split + 1));
    assertJson(resolved);
    return resolved;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveRefs(item, workspace, responses)]),
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
