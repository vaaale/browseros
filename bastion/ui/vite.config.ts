import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/app/",
  server: {
    proxy: {
      "/login": "http://localhost:3000",
      "/logout": "http://localhost:3000",
      "/admin": "http://localhost:3000",
      "/account": "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
  build: { outDir: "dist" },
});
