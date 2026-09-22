import { afterEach, beforeEach, expect, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});

afterEach(() => {
  const remaining = vi.getTimerCount();
  vi.useRealTimers();
  expect(remaining, "SS-4.2: application timers must be owned and cleared").toBe(0);
});
