// The Gmail emails code offered the person with "Add it" (0018, H2, fix
// round 1, R1). A chat turn records each email it offers with the Google
// account it was found in and the case generation. POST
// /api/gmail/<id>/add imports only an email offered for the account
// connected now and the current case. Delete case erases the stream with
// the rest of the case, and a disconnect or another account drops every
// offer.
import type { EventStore } from "../store/event-log.ts";

export const GMAIL_OFFERS_STREAM = "gmail_offers";

export type GmailOffer = { gmail_id: string; account: string; generation: number };
export type GmailOfferEvent = { type: "gmail_offered"; data: GmailOffer } | { type: "gmail_offers_dropped"; data: { reason: string } };

// The offers since the last drop, oldest first.
export function gmailOffers(store: EventStore): GmailOffer[] {
  const out: GmailOffer[] = [];
  for (const e of store.readStream(GMAIL_OFFERS_STREAM) as unknown as GmailOfferEvent[]) {
    if (e.type === "gmail_offers_dropped") out.length = 0;
    else if (e.type === "gmail_offered") out.push(e.data);
  }
  return out;
}

// The ids offered for this account in this case.
export function offeredIds(store: EventStore, account: string, generation: number): Set<string> {
  return new Set(gmailOffers(store).filter((o) => o.account === account && o.generation === generation).map((o) => o.gmail_id));
}

export function recordGmailOffers(store: EventStore, offers: GmailOffer[]): void {
  if (offers.length === 0) return;
  store.transaction(() => {
    store.append(
      GMAIL_OFFERS_STREAM,
      store.streamVersion(GMAIL_OFFERS_STREAM),
      offers.map((data) => ({ type: "gmail_offered", data })),
    );
  });
}

// A disconnect or another account: no earlier offer can be added.
export function dropGmailOffers(store: EventStore, reason: string): void {
  store.inCase(() =>
    store.transaction(() => {
      if (gmailOffers(store).length === 0) return;
      store.append(GMAIL_OFFERS_STREAM, store.streamVersion(GMAIL_OFFERS_STREAM), [{ type: "gmail_offers_dropped", data: { reason } }]);
    }),
  );
}
