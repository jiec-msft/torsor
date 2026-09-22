import { createHash } from "node:crypto";

import { KernelError } from "./errors.js";
import type { JsonValue, KernelCommand, RunState } from "./types.js";

export type Row = Record<string, unknown>;

export function hashPayload(command: KernelCommand): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function parseJson(value: unknown): JsonValue {
  return JSON.parse(text(value)) as JsonValue;
}

export function parseStringArray(value: unknown): readonly string[] {
  const parsed = JSON.parse(text(value));
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored string array is invalid.");
  }
  return parsed;
}

export function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Stored text value is invalid.");
  }
  return value;
}

export function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Stored integer value is invalid.");
  }
  return value;
}

export function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new KernelError("InvalidCommand", `${field} must not be empty.`);
  }
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function boundedLimit(limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new KernelError("InvalidCommand", "Limit must be between 1 and 500.");
  }
  return limit;
}

export function boundedDuration(durationMs: number, field: string): number {
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 1_000 ||
    durationMs > 300_000
  ) {
    throw new KernelError(
      "InvalidCommand",
      `${field} must be between 1 and 300 seconds.`,
    );
  }
  return durationMs;
}

export function isTerminalRunState(
  state: string,
): state is Extract<RunState, "Completed" | "Failed" | "Cancelled"> {
  return state === "Completed" || state === "Failed" || state === "Cancelled";
}

export function assertNever(value: never): never {
  throw new KernelError(
    "InvalidCommand",
    `Unsupported command or query: ${JSON.stringify(value)}`,
  );
}
