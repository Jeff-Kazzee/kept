// Shape of the synthetic fixture files. Scenario messages are either inline
// or a `ref` to a message defined in fixtures/d0-messages.json or in another
// scenario. Every resolved message carries its expected claims, which may be
// an empty list.
import { z } from "zod";
import { ClaimType, Message, SenderKind } from "../domain/claim.ts";
import { TEMPLATE_IDS } from "../reply/templates.ts";

// A field that is absent is not compared. A field set to null must come
// back null.
export const ExpectedClaim = z
  .object({
    claim_type: ClaimType,
    date: z.string().nullable().optional(),
    time: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    // Informational only. Free text is not scored.
    request_item: z.string().optional(),
    sender_kind: SenderKind.optional(),
  })
  .strict();
export type ExpectedClaim = z.infer<typeof ExpectedClaim>;

export const FixtureMessage = Message.extend({ expected: z.array(ExpectedClaim) }).strict();
export type FixtureMessage = z.infer<typeof FixtureMessage>;

const MessageRef = z.object({ ref: z.string().min(1) }).strict();

// An expectation that belongs to a later deliverable. It is kept as text and
// is not checked by D1.
export const LaterStub = z
  .object({
    deliverable: z.string().min(1),
    expect: z.string().min(1),
  })
  .strict();

// D2 expectations over slot states, conflicts and the next question. Each
// checkpoint starts from an empty case and runs its steps in order. A
// message step imports the message, extracts it with the recorded client
// and accepts every claim. An answer step asks the next question, which
// must be of the given kind, and taps the choice with the given label. An
// approve step approves the open reply draft, which must use the given
// template and slot, after reading back every field.
const ConflictKind = z.enum([
  "both_held",
  "change_proposed",
  "unknown_order",
  "ambiguous_date",
  "possibly_stale",
  "location_mismatch",
  "incomplete_slot",
]);

const TemplateId = z.enum(TEMPLATE_IDS);
const TemplateSlot = z.object({ template: TemplateId, slot: z.string().min(1) }).strict();

export const D2Step = z.union([
  z.object({ message: z.string().min(1) }).strict(),
  z.object({ answer: z.object({ kind: ConflictKind, choice: z.string().min(1) }).strict() }).strict(),
  z.object({ approve_reply: TemplateSlot }).strict(),
]);
export type D2Step = z.infer<typeof D2Step>;

export const D2Checkpoint = z
  .object({
    expect: z.string().min(1),
    steps: z.array(D2Step).min(1),
    // Every slot by key, with its state label.
    slots: z.record(z.string(), z.string()),
    // Slots with calendar clashes, by key. Every other slot has none.
    clashes: z.record(z.string(), z.array(z.string())),
    // Held slots that lack a detail, by key. Every other slot lacks none.
    missing: z.record(z.string(), z.array(z.enum(["time", "location"]))),
    stale: z.array(z.string()),
    conflicts: z.array(
      z
        .object({
          kind: ConflictKind,
          slots: z.array(z.string()),
          evidence: z.array(z.string()),
          status: z.enum(["open", "asked", "answered"]),
        })
        .strict(),
    ),
    // The next question the app asks, or null when none waits.
    question: z.object({ kind: ConflictKind, choices: z.array(z.string()) }).strict().nullable(),
    // The open reply draft, or null. Not checked when absent.
    draft: TemplateSlot.nullable().optional(),
  })
  .strict();
export type D2Checkpoint = z.infer<typeof D2Checkpoint>;

// D3 expectations over replies. Steps may also ask the model for a reply
// from a note, start a draft by hand, or edit the open draft. A suggest step
// may name a fault recording that answers in place of the stored one, and
// states the pick a correct model makes (`expect`, null when no template
// fits, or a list of acceptable answers), which the live evaluation scores. `blocked` lists drafts that code
// must refuse after the steps, with their problems. `declined` lists a
// message and notes that the scope check must decline before any model call.
const D3Step = z.union([
  D2Step,
  z
    .object({
      suggest: z
        .object({
          intent: z.string().nullable(),
          recording: z.string().min(1).optional(),
          expect: z.union([TemplateSlot.nullable(), z.array(TemplateSlot.nullable()).min(1)]).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ start_reply: TemplateSlot }).strict(),
  z.object({ edit_reply: z.string().min(1) }).strict(),
]);
export type D3Step = z.infer<typeof D3Step>;

const DraftProblem = z.enum(["unknown_slot", "template_not_valid_for_state", "missing_field"]);

export const D3Checkpoint = z
  .object({
    expect: z.string().min(1),
    steps: z.array(D3Step),
    // Every slot by key, with its state label. Not checked when absent.
    slots: z.record(z.string(), z.string()).optional(),
    // Every message in the case. Not checked when absent.
    messages: z.array(z.string()).optional(),
    options: z.array(TemplateSlot),
    withheld: z.array(TemplateSlot.extend({ missing: z.array(z.enum(["time", "date"])) }).strict()).optional(),
    draft: TemplateSlot.extend({ origin: z.enum(["choice", "model", "manual"]), edited: z.boolean() }).strict().nullable(),
    suggestion: z
      .object({ outcome: z.enum(["valid", "no_fit", "manual_needed"]), problems: z.array(z.array(z.string())) })
      .strict()
      .nullable()
      .optional(),
    sent: z.array(TemplateSlot),
    blocked: z.array(TemplateSlot.extend({ problems: z.array(DraftProblem) }).strict()).optional(),
    declined: z.object({ messages: z.array(z.string()), notes: z.array(z.string()) }).strict().optional(),
  })
  .strict();
export type D3Checkpoint = z.infer<typeof D3Checkpoint>;

export const Scenario = z
  .object({
    id: z.string().regex(/^S\d+$/),
    title: z.string().min(1),
    calendar: z.string().optional(),
    messages: z.array(z.union([MessageRef, FixtureMessage])).min(1),
    model_fault: z
      .object({
        message: z.string().min(1),
        recording: z.string().min(1),
        expect: z.string().min(1),
      })
      .strict()
      .optional(),
    d2: z.array(D2Checkpoint).optional(),
    d3: z.array(D3Checkpoint).optional(),
    later: z.array(LaterStub),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

export type ResolvedScenario = Omit<Scenario, "messages"> & { messages: FixtureMessage[] };

export const BaseMessages = z.array(FixtureMessage);

export const CaseProfile = z.object({ user_name: z.string().trim().min(1).max(100) }).strict();
export type CaseProfile = z.infer<typeof CaseProfile>;
