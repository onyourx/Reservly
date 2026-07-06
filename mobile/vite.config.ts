import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Staff mobile app (installable PWA). Served at /m by the Express server in
// production; dev runs on :5647 with the API proxied.
export default defineConfig({
  plugins: [
    react(),
    {
      // The app lives under /m/ (matching production); send the dev root there.
      name: "serve-root-as-m",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/" || req.url === "/index.html") req.url = "/m/";
          next();
        });
      },
    },
  ],
  base: "/m/",
  server: {
    port: 5647,
    host: true, // bind 0.0.0.0 so staff can load the dev PWA from their phone on the LAN
    proxy: {
      "/api": "http://localhost:4646",
      "/sign": "http://localhost:4646",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
