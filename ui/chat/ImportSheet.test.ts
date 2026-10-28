// "Add an office message" posts to the existing import route with the
// page's write headers, then reads the message through the existing
// extract route. fetch is replaced, so nothing leaves the test.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("import sheet", () => {
  it("imports through /api/messages and reads through /api/messages/:id/extract, with the generation header", async () => {
    const sent: Array<{ path: string; headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal("fetch", async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      sent.push({ path, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      if (path === "/api/state") return { ok: true, status: 200, json: async () => ({ generation: 2 }) };
      if (path === "/api/messages") return { ok: true, status: 200, json: async () => ({ id: "pasted-1", version: 1 }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const { importOfficeMessage } = await import("./ImportSheet.tsx");
    const id = await importOfficeMessage({ channel: "email", from: " Lantern Hill Clinic ", receivedAt: "2026-11-04T11:40:00-07:00", text: "Please bring your lab results on Monday." });
    expect(id).toBe("pasted-1");
    const writes = sent.filter((s) => s.path !== "/api/state");
    expect(writes.map((w) => w.path)).toEqual(["/api/messages", "/api/messages/pasted-1/extract"]);
    expect(writes[0]!.body).toEqual({ channel: "email", from: "Lantern Hill Clinic", received_at: "2026-11-04T11:40:00-07:00", text: "Please bring your lab results on Monday." });
    expect(writes[1]!.body).toEqual({ effort: "minimal", expectedVersion: 1 });
    expect(writes.every((w) => w.headers["X-Case-Generation"] === "2" && w.headers["X-Appointments-App"] === "1")).toBe(true);
  });

  it("every field has a label, an id and a name, and the time is America/Denver", async () => {
    const { ImportSheet } = await import("./ImportSheet.tsx");
    const html = renderToStaticMarkup(createElement(ImportSheet, { request: null, run: async () => {}, onClose: () => {}, onImported: () => {} }));
    for (const name of ["import-channel", "import-from", "import-received", "import-text"]) expect(html).toMatch(new RegExp(`<(input|select|textarea)[^>]*id="[^"]+"[^>]*name="${name}"`));
    expect(html).toContain("Received (America/Denver time)");
    expect(html).toContain("Add and read the message");
  });
});
