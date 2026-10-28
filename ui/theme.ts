// Light and dark themes. By default the page follows the system setting.
// A manual choice is kept in this browser's localStorage under one key and
// holds nothing but the theme name.
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "appointments-theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function saveTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage can be off. The choice then lasts until the page reloads.
  }
}
