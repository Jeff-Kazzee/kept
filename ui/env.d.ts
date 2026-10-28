// Vite handles CSS imports and sets import.meta.env.DEV: true in development,
// false in `pnpm build`. Only these two are declared, so the page does not
// pick up Vite's other client types.
declare module "*.css";

interface ImportMeta {
  // APP_FAKES: a check build with the scripted chat (vite.config.ts).
  readonly env: { readonly DEV: boolean; readonly APP_FAKES?: boolean };
}
