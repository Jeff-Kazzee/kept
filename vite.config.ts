// Vite settings for the UI. `pnpm dev` runs Vite in middleware mode inside
// server/main.ts with this file. `pnpm build` writes the production bundle
// to dist/ui, which `pnpm start` serves through server/static.ts.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("./ui"),
  publicDir: "public",
  appType: "spa",
  build: {
    outDir: here("./dist/ui"),
    emptyOutDir: true,
    // Every asset is a file of its own, so the Content-Security-Policy
    // needs no data: URLs.
    assetsInlineLimit: 0,
    // Browsers the app supports load module preloads natively.
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    sourcemap: false,
  },
});
