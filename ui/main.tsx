import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { applyTheme, readTheme } from "./theme.ts";

applyTheme(readTheme());
// "System" follows the device when it changes.
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (readTheme() === "system") applyTheme("system");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
