import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    isolate: false,
    maxWorkers: 1,
    setupFiles: ["./test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
