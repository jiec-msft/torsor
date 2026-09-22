import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4174,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/health": "http://127.0.0.1:4317",
    },
  },
  test: {
    environment: "jsdom",
    server: {
      // Keep SQLite in native Node when jsdom tests use the real HTTP service.
      deps: { external: [/\/packages\/kernel\/dist\//] },
    },
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});
