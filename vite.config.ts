// Vite settings for the UI. `pnpm dev` runs Vite in middleware mode inside
// server/main.ts with this file. `pnpm build` writes the production bundle
// to dist/ui, which `pnpm start` serves through server/static.ts.
//
// The scripted chat is a development tool, and no route is faked (0011,
// U51). A development build has the scripted chat. `APP_UI_FAKES=1 pnpm
// build` makes a check build that has it too, for a browser check of the
// minified bundle. It is never the build that ships: a plain `pnpm build`
// sets import.meta.env.APP_FAKES to false, and the code behind it is
// dropped.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => ({
  root: here("./ui"),
  publicDir: "public",
  appType: "spa",
  define: {
    "import.meta.env.APP_FAKES": JSON.stringify(mode !== "production" || process.env.APP_UI_FAKES === "1"),
  },
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
}));
