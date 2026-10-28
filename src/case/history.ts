// The case history: every event of the case in the order it was written,
// each with a label code builds from the event kind, ids, counts, dates and
// times. No free text is repeated here: not message text, quotes, notes,
// proposal statements, tags, file names or choice labels, which can carry
// words from messages. The views that show them label them. Grants are app settings, not
// case events, so they are left out. An undo shows as its own entry and
// marks the entry it reversed.
import type { EvidenceClaim } from "../domain/claim.ts";
import type { EvidenceEvent, MessageEvent } from "../intake/events.ts";
import type { AccessEvent, Actor, ProposalEvent, RecordEvent } from "../records/events.ts";
import type { ReplyEvent } from "../reply/events.ts";
import { TEMPLATES } from "../reply/templates.ts";
import { slotLabel } from "../slots/labels.ts";
import type { StoredEvent } from "../store/event-log.ts";
import { GRANT_PREFIX } from "../grants/grants.ts";
import type { CaseEvent } from "./events.ts";

export type HistoryEntry = {
  seq: number;
  at: string;
  streamId: string;
  label: string;
  // True when a later undo reversed this event.
  undone: boolean;
};

type AnyEvent = MessageEvent | EvidenceEvent | CaseEvent | ReplyEvent | RecordEvent | ProposalEvent | AccessEvent;

const CLAIM_WORDS: Record<EvidenceClaim["claim_type"], string> = {
  offer: "offer",
  confirm: "confirmation",
  cancel: "cancellation",
  move: "move",
  reminder: "reminder",
  office_request: "office request",
  request: "request",
  decline: "decline",
  clarify: "detail",
};

function claimText(c: EvidenceClaim): string {
  const words = CLAIM_WORDS[c.claim_type] ?? c.claim_type;
  return c.slot.date === null ? words : `${words} for ${slotLabel(c.slot.date, c.slot.time)}`;
}

const actor = (by: Actor) => (by.kind === "user" ? "by you" : `by ${by.grant_name}`);
const after = (id: string, prefix: string) => id.slice(prefix.length);

const APPROVAL_CLAIMS = {
  recorded: "Claims recorded.",
  none: "No claim to record.",
  not_confirmed: "Claims not confirmed.",
} as const;

const EXTRACTION_OUTCOME = {
  claims_pending: "claims wait for your review",
  no_claims: "no appointment facts found",
  manual_entry_needed: "manual entry needed",
} as const;

// The label for one event, or null for an event the history folds into the
// one before it.
function label(e: StoredEvent): string | null {
  const event = { type: e.type, data: e.data } as AnyEvent;
  const evidence = after(e.streamId, "evidence:");
  const record = after(e.streamId, "record:");
  const proposal = after(e.streamId, "proposal:");
  switch (event.type) {
    case "message_imported":
      return `Message ${event.data.message.id} added (${event.data.message.channel.replaceAll("_", " ")})`;
    case "extraction_attempted":
      return `Extraction attempt ${event.data.attempt} at effort ${event.data.effort}: ${event.data.outcome === "valid" ? "passed the code checks" : `failed (${event.data.problem ?? "invalid"})`}`;
    case "claim_rejected":
      return `Code rejected a model claim (${event.data.problems.join(", ")})`;
    case "extraction_finished":
      return `Extraction finished: ${EXTRACTION_OUTCOME[event.data.outcome]}`;
    case "manual_entry_recorded":
      return `Claim ${event.data.evidence_id} entered by you`;
    case "claim_extracted":
      return `Claim ${evidence} extracted: ${claimText(event.data.claim)}`;
    case "claim_entered_manually":
      return `Claim ${evidence} saved for review: ${claimText(event.data.claim)}`;
    case "claim_accepted":
      return `You accepted claim ${evidence}`;
    case "claim_rejected_by_user":
      return `You rejected claim ${evidence}`;
    case "answer_recorded":
      return `Your answer recorded as claim ${evidence}: ${claimText(event.data.claim)}`;
    case "reply_recorded":
      return `Your approved reply recorded as claim ${evidence}: ${claimText(event.data.claim)}`;
    case "agent_report_confirmed":
      return `You confirmed a report from ${event.data.claim.agent_name ?? "an agent"} as claim ${evidence}: ${claimText(event.data.claim)}`;
    case "calendar_loaded":
      return "Calendar loaded";
    case "question_asked":
      return `Question ${event.data.question_id} asked (${event.data.origin === "model" ? "model wording, passed the code checks" : "fixed wording"})`;
    case "question_withdrawn":
      return `Question ${event.data.question_id} withdrawn because its conflict changed`;
    case "question_answered":
      return `Question ${event.data.question_id} answered (choice ${event.data.choice_id})`;
    case "explanation_attempted":
      return `Model explanation attempt ${event.data.attempt}: ${event.data.outcome === "valid" ? "passed the code checks" : "failed the code checks"}`;
    case "explanation_finished":
      return event.data.outcome === "valid" ? "Explanation stored" : "Explanation unavailable after two failed attempts";
    case "reply_suggested":
      return `Model reply suggestion ${event.data.suggestion_id}: ${event.data.outcome === "valid" ? "passed the code checks" : event.data.outcome === "no_fit" ? "no template fits" : "pick by hand"}`;
    case "reply_drafted":
      return `Draft ${event.data.draft_id} started: ${TEMPLATES[event.data.template].title}, ${event.data.slot_label}`;
    case "reply_edited":
      return `Draft ${event.data.draft_id} edited`;
    case "reply_discarded":
      return `Draft ${event.data.draft_id} discarded${event.data.reason === "replaced" ? " because a new draft replaced it" : ""}`;
    case "reply_approved":
      return `Draft ${event.data.draft_id} approved. Simulated send. ${APPROVAL_CLAIMS[event.data.claims]}`;
    case "reply_send_simulated":
      // Written with the approval, whose label already says it.
      return null;
    case "note_added":
      return `Note ${event.data.note_id} added to ${record} ${actor(event.data.by)}`;
    case "tags_set":
      return `Tags on ${record} set ${actor(event.data.by)} (${event.data.tags.length === 1 ? "1 tag" : `${event.data.tags.length} tags`})`;
    case "record_archived":
      return `${record} archived ${actor(event.data.by)}${event.data.proposal_id ? ` from proposal ${event.data.proposal_id}` : ""}`;
    case "event_undone":
      return `Undo on ${record} ${actor(event.data.by)}: reversed version ${event.data.version}`;
    case "change_proposed":
      return `${event.data.grant_name} proposed a change (${event.data.change.kind.replaceAll("_", " ")}), proposal ${proposal}`;
    case "proposal_confirmed":
      return `You confirmed proposal ${proposal}`;
    case "proposal_rejected":
      return `You rejected proposal ${proposal}`;
    case "tool_called": {
      const d = event.data;
      const count = d.count === undefined ? "" : ` (${d.count} calls)`;
      return `Agent call by ${d.grant_name ?? "an unknown grant"}: ${d.tool} · ${d.result.replaceAll("_", " ")}${count}`;
    }
  }
  return `${e.type} on ${e.streamId}`;
}

export function caseHistory(events: StoredEvent[]): HistoryEntry[] {
  const undone = new Set<string>();
  for (const e of events) {
    if (e.type === "event_undone") undone.add(`${e.streamId}#${(e.data as { version: number }).version}`);
  }
  const entries: HistoryEntry[] = [];
  for (const e of events) {
    if (e.streamId.startsWith(GRANT_PREFIX)) continue;
    const text = label(e);
    if (text === null) continue;
    entries.push({ seq: e.seq, at: e.recordedAt, streamId: e.streamId, label: text, undone: undone.has(`${e.streamId}#${e.version}`) });
  }
  return entries;
}
