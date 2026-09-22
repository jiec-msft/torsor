import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { setImmediate } from "node:timers/promises";
import type { PublicEventEnvelope } from "@torsor/kernel";
import type { WebEventSource } from "@torsor/web/controller";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class HttpTransport {
  readonly requests: Array<{ path: string; method: string; body: string | null }> = [];
  readonly #pending = new Set<Promise<unknown>>();
  readonly #faults: Array<{ path: string; kind: "loss" | "read" }> = [];
  #cookie = "";

  constructor(readonly origin: string) {}

  loseNextResponse(path: string): void { this.#faults.push({ path, kind: "loss" }); }
  failNextRead(path: string): void { this.#faults.push({ path, kind: "read" }); }

  headers(): Record<string, string> {
    return this.#cookie ? { Cookie: this.#cookie } : {};
  }

  fetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== this.origin) throw new Error("Only the owned loopback origin is allowed.");
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      throw new Error("Scenario HTTP bodies must be strings.");
    }
    this.requests.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: body ?? null });
    const faultIndex = this.#faults.findIndex((fault) => fault.path === url.pathname);
    const fault = faultIndex < 0 ? undefined : this.#faults.splice(faultIndex, 1)[0];
    if (fault?.kind === "read" && init?.method && init.method !== "GET") {
      throw new Error("Read faults cannot intercept commands.");
    }
    const pending = new Promise<Response>((resolve, reject) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(this.headers())) headers.set(key, value);
      const req = request(url, {
        method: init?.method ?? "GET", headers: Object.fromEntries(headers), agent: false,
      }, (response) => {
        const cookie = response.headers["set-cookie"]?.[0];
        if (cookie) this.#cookie = cookie.split(";", 1)[0]!;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          if (fault?.kind === "loss") {
            reject(new TypeError("Synthetic response lost after the server completed the request."));
            return;
          }
          if (fault?.kind === "read") {
            resolve(new Response(JSON.stringify({
              error: { code: "synthetic_read_failure", message: "Synthetic projection read failed." },
            }), { status: 503 }));
            return;
          }
          const resultHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), {
            status: response.statusCode ?? 500, headers: resultHeaders,
          }));
        });
      });
      req.on("error", reject);
      req.end(body);
    });
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  };

  async settle(): Promise<void> {
    for (let pass = 0; pass < 100; pass += 1) {
      await Promise.all(this.#pending);
      await setImmediate();
      if (this.#pending.size === 0) return;
    }
    throw new Error("HTTP projection reads did not settle within 100 rounds.");
  }

  assertConsumed(): void {
    if (this.#faults.length) throw new Error("Unused HTTP fault controls remain.");
  }
}

export class HttpEventSource extends EventTarget implements WebEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly received: PublicEventEnvelope[] = [];
  #request: ClientRequest | null = null;
  #response: IncomingMessage | null = null;
  #closed: Promise<void> = Promise.resolve();
  #cursor: string | null;

  constructor(readonly url: string, readonly transport: HttpTransport) {
    super();
    this.#cursor = new URL(url).searchParams.get("cursor");
  }

  close(): void {
    this.#response?.destroy();
    this.#request?.destroy();
  }

  async finished(): Promise<void> {
    await this.#closed;
  }

  async disconnect(): Promise<void> {
    this.onerror?.(new Event("error"));
    this.close();
    await this.finished();
  }

  async replay(order: "reverse-duplicate"): Promise<void> {
    if (order !== "reverse-duplicate") throw new Error("Unknown SSE replay order.");
    for (const event of [...this.received].reverse()) {
      for (let duplicate = 0; duplicate < 2; duplicate += 1) {
        this.dispatchEvent(new MessageEvent("torsor", { data: JSON.stringify(event) }));
      }
    }
    await this.transport.settle();
  }

  async sync(target: string | null, delivery?: "reverse-duplicate"): Promise<void> {
    if (target === this.#cursor) return;
    this.close();
    await this.finished();
    const url = new URL(this.url);
    if (this.#cursor) url.searchParams.set("cursor", this.#cursor);
    else url.searchParams.delete("cursor");
    const reached = deferred<void>();
    const closed = deferred<void>();
    this.#closed = closed.promise;
    let reachedTarget = false;
    let buffer = "";
    const frames: Array<{ type: string; data: string }> = [];
    const req = request(url, { headers: this.transport.headers(), agent: false }, (response) => {
      this.#response = response;
      if (response.statusCode !== 200) {
        reached.reject(new Error(`SSE status ${response.statusCode}.`));
        response.resume();
        return;
      }
      response.setEncoding("utf8");
      response.on("error", (error) => { if (!reachedTarget) reached.reject(error); });
      response.on("data", (chunk: string) => {
        if (reachedTarget) return;
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = frame.split("\n");
          const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
          const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
          if (!id || !type || !data) continue;
          if (type === "torsor") this.received.push(JSON.parse(data) as PublicEventEnvelope);
          this.#cursor = id;
          frames.push({ type, data });
          if (id === target) {
            reachedTarget = true;
            reached.resolve();
            break;
          }
        }
      });
    });
    this.#request = req;
    req.on("error", reached.reject);
    req.on("close", () => {
      closed.resolve();
      if (!reachedTarget) reached.reject(new Error("SSE closed before the durable target."));
    });
    req.end();
    await reached.promise;
    this.close();
    await this.finished();
    this.onopen?.(new Event("open"));
    const delivered = delivery === "reverse-duplicate"
      ? [...frames].reverse().flatMap((frame) => [frame, frame])
      : frames;
    for (const frame of delivered) this.dispatchEvent(new MessageEvent(frame.type, { data: frame.data }));
    await this.transport.settle();
  }
}
