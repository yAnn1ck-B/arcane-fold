import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: at("./src/web"),
  publicDir: at("./public"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@/services/league-transport", replacement: at("./src/web/league-transport.ts") },
      { find: "@", replacement: at("./src") },
    ],
  },
  build: { outDir: at("./dist-web"), emptyOutDir: true },
});
