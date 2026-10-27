// Shape of the synthetic fixture files. Scenario messages are either inline
// or a `ref` to a message defined in fixtures/d0-messages.json or in another
// scenario. Every resolved message carries its expected claims, which may be
// an empty list.
import { z } from "zod";
import { ClaimType, Message, SenderKind } from "../domain/claim.ts";

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
    later: z.array(LaterStub),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

export type ResolvedScenario = Omit<Scenario, "messages"> & { messages: FixtureMessage[] };

export const BaseMessages = z.array(FixtureMessage);
