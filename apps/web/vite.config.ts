import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * In development the API runs separately on port 3000. Vite forwards /api
 * (and the API docs) to it, so the browser sees ONE origin: cookies stay
 * first-party and no CORS configuration is needed (ADR-019). Production does
 * the same with a reverse proxy.
 */
const api = "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: api },
      "/docs": { target: api },
    },
  },
  build: {
    sourcemap: true,
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
