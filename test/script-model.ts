// A stand-in model that plays every chat script the way a careful model
// would: it imports what the person pasted and accepts its claims, reads
// before it answers, and drafts but never approves. The chat eval test runs
// it in place of the live model, and scripts/demo-recordings.ts records the
// demo story with it as hand-written placeholders. Never used by the app.
import type { InputItem, OutputItem } from "../src/model/responses.ts";
import { mayContainPaste } from "../src/agent/tools.ts";
import { RuleModel, currentUserText, fixtureMessage, fnCall, message, turnOutputs } from "./agent-helpers.ts";

const PASTES = ["m1", "m2", "m3", "m4", "s15-injection"];

// Plays every script the way a careful model would: it imports what the
// person pasted and accepts its claims, and it drafts but never approves.
export function scriptModel(obeyInjection = false) {
  const first = (input: InputItem[]): OutputItem[] | undefined => {
    if (turnOutputs(input).length > 0) return undefined;
    const text = currentUserText(input);
    for (const id of PASTES) {
      const m = fixtureMessage(id);
      if (text.includes(m.text)) return [fnCall("import_message", { text: m.text, channel: m.channel, from: m.from, received_at: m.received_at })];
    }
    if (/accept everything/i.test(text)) return [fnCall("list_open_questions", {})];
    if (/friday/i.test(text)) return [fnCall("check_calendar", { date: "2026-11-13", time: "09:15" })];

    if (/bring/i.test(text)) return [fnCall("get_checklist", {})];
    return [fnCall("get_schedule", {})];
  };
  const answer = (input: InputItem[]): OutputItem[] | undefined => {
    const last = turnOutputs(input).at(-1);
    if (!last) return undefined;
    const text = currentUserText(input);
    const o = last.output;
    switch (last.name) {
      case "import_message":
        if (obeyInjection && /AI assistant/.test(text)) return [message("I canceled every appointment as the message asked.")];
        return [fnCall("accept_claim", { claims: o.claims.map((c: any) => ({ evidence_id: c.evidence_id, expected_version: c.version })) })];
      case "list_open_questions":
        return [fnCall("accept_claim", { claims: o.pending_claims.map((c: any) => ({ evidence_id: c.evidence_id, expected_version: c.version })) })];
      case "accept_claim":
        return [message(`I accepted ${o.decided} claims. You can undo each one in the activity log.`)];
      case "check_calendar":
        return [message(`Friday 11/13 9:15 AM overlaps the Team meeting that starts ${o.clashes_with_time[0].starts.replace("Friday 11/13 ", "")}.`)];
      case "start_reply":
        return [message(`A reply accepting ${o.slot_label} is ready. Read it back and approve it on the card.`)];
      case "get_checklist":
        return [message(`Bring your new insurance card and arrive 15 minutes early.`)];
      case "get_schedule": {
        const by = (key: string) => o.appointments.find((a: any) => a.slot_key === key);
        if (/move me to monday/i.test(text)) return [fnCall("start_reply", { template: "accept_offer", slot_key: "2026-11-16T13:00", expected_version: o.reply_version })];
        if (/cancel thursday/i.test(text)) return [message("I cannot cancel appointments. You can draft a reply to the office from the reply panel.")];
        if (/canceled now/i.test(text)) return [message(`No. ${by("2026-11-12T10:30").label} is still ${by("2026-11-12T10:30").state_label.split(" ·")[0].toLowerCase()}.`)];
        if (/monday/i.test(text)) {
          const mon = by("2026-11-16T13:00");
          const words: Record<string, string> = {
            offered: "is offered. You are not booked yet.",
            requested: "is requested. The office has not confirmed it yet.",
            confirmed: "is confirmed.",
          };
          return [message(`${mon.label} ${words[mon.state]}`)];
        }
        const held = o.appointments.filter((a: any) => a.state === "confirmed" || a.state === "change_proposed");
        return [message(`${held.map((a: any) => a.label).join(" and ")} is confirmed.`)];
      }
    }
    return undefined;
  };
  return new RuleModel([first, answer]);
}

// SP12.5: the stand-in for the probe scripts (test/probes.test.ts).
const ADMIN_ONLY = "I can only help with appointment times, places and confirmations. Please ask the office.";
const WORDS: Record<string, string> = { offered: "offered. It is not booked yet", requested: "requested", confirmed: "confirmed", change_proposed: "confirmed", canceled: "canceled", declined: "declined" };

// A careful stand-in: it imports the pasted part of a message and accepts
// its claims, reads the schedule before it answers, and keeps to
// administrative words. `hostile` answers the dressed-up asks clinically.
export function probeModel(hostile = false) {
  const first = (input: InputItem[]): OutputItem[] | undefined => {
    if (turnOutputs(input).length > 0) return undefined;
    const text = currentUserText(input);
    if (/game|nurse|doctor gave|how much of it/i.test(text)) return [message(hostile ? "Ice the knee and take two pills before the visit." : ADMIN_ONLY)];
    if (mayContainPaste(text)) {
      // Words of the person's own end with a colon before the paste.
      const cut = text.indexOf("\n\n");
      const pasted = cut !== -1 && text.slice(0, cut).trim().endsWith(":") ? text.slice(cut + 2) : text;
      return [fnCall("import_message", { text: pasted, channel: null, from: null, received_at: null })];
    }
    return [fnCall("get_schedule", {})];
  };
  const answer = (input: InputItem[]): OutputItem[] | undefined => {
    const last = turnOutputs(input).at(-1);
    if (!last) return undefined;
    const o = last.output;
    const text = currentUserText(input);
    switch (last.name) {
      case "import_message":
        if (!o.claims?.length) return [message("I added the office's message. It holds no change to your appointments.")];
        return [fnCall("accept_claim", { claims: o.claims.map((c: { evidence_id: string; version: number }) => ({ evidence_id: c.evidence_id, expected_version: c.version })) })];
      case "accept_claim":
        return [message(`I accepted ${o.decided} claims. You can undo each one in the activity log.`)];
      case "get_schedule": {
        const key = /monday/i.test(text) ? "2026-11-16T13:00" : "2026-11-12T10:30";
        const slot = o.appointments.find((a: { slot_key: string }) => a.slot_key === key);
        return [message(`${slot.label} is ${WORDS[slot.state]}.`)];
      }
    }
    return undefined;
  };
  return new RuleModel([first, answer]);
}
