// The Gmail emails code offered the person with "Add it" (0018, H2, fix
// rounds 1 and 2). A chat turn records each email it offers with a hash of
// the Google account it was found in and the case generation. POST
// /api/gmail/<id>/add imports only an email offered for the account
// connected now and the current case, and uses the offer. An Undo of that
// import makes it addable again, so the card that offers it again works.
// Delete case erases the stream with the rest of the case, and a
// disconnect or another account drops every offer.
import { createHash } from "node:crypto";
import type { EventStore } from "../store/event-log.ts";

export const GMAIL_OFFERS_STREAM = "gmail_offers";

// `account` is accountTag(sub), never the account's id itself (fix round
// 2, F3).
type Offered = { gmail_id: string; account: string; generation: number };
export type GmailOffer = Offered & { used: boolean };
export type GmailOfferEvent =
  | { type: "gmail_offered"; data: Offered }
  | { type: "gmail_offer_used"; data: { gmail_id: string } }
  | { type: "gmail_offers_dropped"; data: { reason: string } };

export const accountTag = (sub: string) => createHash("sha256").update(`appointments-gmail-offer:${sub}`).digest("hex").slice(0, 32);

// The offers since the last drop, oldest first.
export function gmailOffers(store: EventStore): GmailOffer[] {
  let out: GmailOffer[] = [];
  for (const e of store.readStream(GMAIL_OFFERS_STREAM) as unknown as GmailOfferEvent[]) {
    if (e.type === "gmail_offers_dropped") out = [];
    else if (e.type === "gmail_offered") out.push({ ...e.data, used: false });
    else if (e.type === "gmail_offer_used") out = out.map((o) => (o.gmail_id === e.data.gmail_id ? { ...o, used: true } : o));
  }
  return out;
}

const forCase = (store: EventStore, sub: string, generation: number) => {
  const tag = accountTag(sub);
  return gmailOffers(store).filter((o) => o.account === tag && o.generation === generation);
};

// The ids offered for this account in this case, used or not.
export function offeredIds(store: EventStore, sub: string, generation: number): Set<string> {
  return new Set(forCase(store, sub, generation).map((o) => o.gmail_id));
}

// An offer "Add it" may use now: not used yet, or used by an import that
// was undone since, so the email is not in the case.
export function addableOffer(store: EventStore, sub: string, generation: number, gmailId: string, inCase: boolean): boolean {
  return forCase(store, sub, generation).some((o) => o.gmail_id === gmailId && (!o.used || !inCase));
}

export function recordGmailOffers(store: EventStore, offers: Offered[]): void {
  if (offers.length === 0) return;
  store.transaction(() => {
    store.append(
      GMAIL_OFFERS_STREAM,
      store.streamVersion(GMAIL_OFFERS_STREAM),
      offers.map((o) => ({ type: "gmail_offered", data: { ...o, account: accountTag(o.account) } })),
    );
  });
}

export function useGmailOffer(store: EventStore, gmailId: string): void {
  store.append(GMAIL_OFFERS_STREAM, store.streamVersion(GMAIL_OFFERS_STREAM), [{ type: "gmail_offer_used", data: { gmail_id: gmailId } }]);
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
