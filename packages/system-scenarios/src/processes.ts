import { createHash } from "node:crypto";
import type { LocalWorktreeExecutorOptions } from "@torsor/agent-runtime";
import { deferred } from "./transport.js";

type ProcessDriver = NonNullable<LocalWorktreeExecutorOptions["driver"]>;
type Child = ReturnType<ProcessDriver["start"]>;
type CloseEvidence = Awaited<Child["closed"]>;

class ScriptedProcess implements Child {
  readonly #result = deferred<string>();
  readonly #closed = deferred<CloseEvidence>();
  readonly result = this.#result.promise;
  readonly closed: Child["closed"] = this.#closed.promise;
  live = true;
  stopRequests = 0;
  forceRequests = 0;

  constructor(readonly pid: number, private readonly content: string, private readonly held: boolean) {
    if (!held) this.emitResult();
  }

  emitResult(): void {
    this.#result.resolve(createHash("sha256").update(this.content).digest("hex"));
  }

  confirmStop(): void {
    this.live = false;
    this.#closed.resolve({ code: 0, signal: null, error: null });
  }

  requestStop(): void {
    this.stopRequests += 1;
    if (!this.held) this.confirmStop();
  }

  forceStop(): boolean {
    this.forceRequests += 1;
    return false;
  }
}

export class ScriptedProcesses implements ProcessDriver {
  readonly #children: ScriptedProcess[] = [];
  #next: ReturnType<typeof deferred<ScriptedProcess>> | undefined;

  holdNext(): Promise<ScriptedProcess> {
    if (this.#next) throw new Error("A held process script is already waiting for admission.");
    this.#next = deferred<ScriptedProcess>();
    return this.#next.promise;
  }

  start({ content }: Parameters<ProcessDriver["start"]>[0]): Child {
    const next = this.#next;
    this.#next = undefined;
    const child = new ScriptedProcess(10_000 + this.#children.length, content, next !== undefined);
    this.#children.push(child);
    next?.resolve(child);
    return child;
  }

  close(): void {
    for (const child of this.#children) {
      child.emitResult();
      child.confirmStop();
    }
    if (this.#next) throw new Error("A held process script was not consumed.");
  }
}
