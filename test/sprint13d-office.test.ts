// Sprint 13D, E6 (0017): the page never shows an email account's name for
// a moment before the office's fuller name replaces it.
import { describe, expect, it } from "vitest";
import type { EvidenceView, MessageView } from "../src/intake/events.ts";
import { officeNameOf, officeNameShown } from "../src/reply/office.ts";

const PLACE = "Lantern Hill Clinic, 400 Elm Street, Suite 2";

const message = (id: string, from: string, extra: Partial<MessageView> = {}): MessageView =>
  ({
    id,
    version: 1,
    message: { id, channel: "email", from, received_at: "2026-10-29T00:43:00.000Z", text: "x" },
    sourceType: "office_message",
    importedFrom: "gmail",
    status: "extracted",
    evidenceIds: [],
    manualEvidenceIds: [],
    ...extra,
  }) as MessageView;

const fact = (id: string, messageId: string, status: string, location: string | null): EvidenceView =>
  ({ id, version: 1, messageId, status, claim: { claim_type: "offer", slot: { date: "2026-11-16", time: "13:00", location }, quote: "q" } }) as unknown as EvidenceView;

describe("sprint 13D, E6: the office's name as shown", () => {
  const from = "lantern hill <front@lanternhill.example>";

  it("is held back while the office's email is not read yet or its place waits for review", () => {
    const unread = message("gmail-1", from, { status: "imported" });
    expect(officeNameOf(unread, [], [unread])).toBe("lantern hill");
    expect(officeNameShown(unread, [], [unread])).toBeNull();
    const read = message("gmail-1", from);
    expect(officeNameShown(read, [fact("e1", "gmail-1", "pending", PLACE)], [read])).toBeNull();
  });

  it("is the fuller name once the place is accepted, even while another fact waits", () => {
    const read = message("gmail-1", from);
    const ev = [fact("e1", "gmail-1", "accepted", PLACE), fact("e2", "gmail-1", "pending", "Annex, 12 Oak Road")];
    expect(officeNameShown(read, ev, [read])).toBe("Lantern Hill Clinic");
  });

  it("is the account's name once nothing that could change it waits", () => {
    const read = message("gmail-1", from);
    // A pending fact without a place cannot change the name.
    expect(officeNameShown(read, [fact("e1", "gmail-1", "pending", null)], [read])).toBe("lantern hill");
    expect(officeNameShown(read, [fact("e1", "gmail-1", "rejected", PLACE)], [read])).toBe("lantern hill");
  });

  it("waits for every email from the same address, and a pasted sender shows as given", () => {
    const first = message("gmail-1", from);
    const second = message("gmail-2", "Front Desk <front@lanternhill.example>", { status: "imported" });
    expect(officeNameShown(first, [], [first, second])).toBeNull();
    const pasted = message("m-1", "lantern hill", { importedFrom: undefined, status: "imported" });
    expect(officeNameShown(pasted, [], [pasted])).toBe("lantern hill");
  });
});
