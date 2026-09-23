import { afterEach, beforeEach, expect, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
});

afterEach(() => {
  const remaining = vi.isFakeTimers() ? vi.getTimerCount() : 0;
  vi.useRealTimers();
  expect(remaining, "SS-4.2: application timers must be owned and cleared").toBe(0);
});
