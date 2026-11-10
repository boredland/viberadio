import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Files from web/public that the shell needs offline; they are not part of the bundle so are listed by hand. */
const PUBLIC_SHELL = [
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

/** Emits dist/sw.js with the hashed bundle files baked into its precache list. */
function serviceWorker(): Plugin {
  return {
    name: "viberadio-sw",
    apply: "build",
    generateBundle(_, bundle) {
      const assets = Object.keys(bundle).filter((f) => f.startsWith("assets/")).map((f) => `/${f}`);
      const precache = ["/", ...PUBLIC_SHELL, ...assets];
      // The version changes whenever any hashed filename does, which is what makes browsers install the new worker.
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(resolve(__dirname, "sw.template.js"), "utf8")
        .replace("__VERSION__", version)
        .replace("__PRECACHE__", JSON.stringify(precache));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [react(), serviceWorker()],
  build: { outDir: "../dist", emptyOutDir: true },
});
