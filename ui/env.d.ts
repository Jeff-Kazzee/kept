// Vite handles CSS imports and sets import.meta.env.DEV: true in development,
// false in `pnpm build`. Only these two are declared, so the page does not
// pick up Vite's other client types.
declare module "*.css";

interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
