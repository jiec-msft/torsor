import { createHook } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";

const handleTypes = new Set(["TCPSERVERWRAP", "TCPWRAP", "PROCESSWRAP", "PIPEWRAP", "Timeout"]);

export function trackHandles() {
  const live = new Map<number, string>();
  const hook = createHook({
    init(id, type) {
      if (!handleTypes.has(type)) return;
      // Node owns one process-global, unref'ed HTTP Date-header cache timer.
      // It is not cancellable by an HTTP server's close operation.
      if (type === "Timeout" && new Error().stack?.includes("at cache (node:internal/http:")) return;
      live.set(id, type);
    },
    destroy(id) { live.delete(id); },
  });
  hook.enable();
  return async () => {
    // Native close callbacks precede async_hooks' destroy notification.
    await setImmediate();
    await setImmediate();
    hook.disable();
    if (live.size) {
      throw new Error(`Scenario leaked handles: ${[...live.values()].sort().join(", ")}.`);
    }
  };
}
