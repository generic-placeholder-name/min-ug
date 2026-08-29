import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

function staticFallback (): Plugin {
  return {
    name: "min-ug-static-fallback",
    async closeBundle () {
      await copyFile(
        fileURLToPath(new URL("./dist/index.html", import.meta.url)),
        fileURLToPath(new URL("./dist/404.html", import.meta.url))
      );
    }
  };
}

export default defineConfig({
  root: webRoot,
  base: "/",
  plugins: [staticFallback()],
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [workspaceRoot] }
  },
  preview: {
    port: 4173,
    strictPort: true
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0
  }
});
