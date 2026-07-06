import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Admin SPA ("Booking Desk"). The Express server (port 4646) owns /api and the
// Shopify surfaces (/webhooks, /proxy); in dev, Vite proxies those through.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5646,
    host: true, // bind 0.0.0.0 so the dev server (with hot reload) is reachable from a phone on the LAN
    proxy: {
      "/api": "http://localhost:4646",
      "/print": "http://localhost:4646",
      "/sign": "http://localhost:4646",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
