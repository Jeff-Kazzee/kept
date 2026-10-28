// Dark and light themes. Dark is the default. "System" follows the device.
// The choice is kept in this browser's localStorage under one key and holds
// nothing but the theme name. index.html starts as dark, so a light choice
// can show dark for a moment on load. No inline script, so the
// Content-Security-Policy stays strict. The theme-color meta tag follows
// the theme in use, for the phone's browser bar.
export type ThemeChoice = "dark" | "light" | "system";

const KEY = "appointments-theme";

// Sent on the window after every change, so each theme switch on the page
// shows the choice (0015, Z7).
export const THEME_EVENT = "appointments-theme";

export const THEME_COLORS = { dark: "#0f1714", light: "#f3f2ec" } as const;

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

function resolved(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  root.dataset.theme = choice;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved(choice)]);
}

export function saveTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === "dark") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage can be off. The choice then lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent<ThemeChoice>(THEME_EVENT, { detail: choice }));
}
