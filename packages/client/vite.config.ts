import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // In development the game server runs separately; send WebSocket traffic to it.
    proxy: { "/ws": { target: "ws://localhost:8787", ws: true } },
  },
});
