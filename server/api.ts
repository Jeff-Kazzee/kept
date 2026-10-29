// JSON API for the UI. Kept free of sockets so tests can call it directly.
// The browser never sees the API key: the model client lives here. Every
// action goes through the case actions (src/actions/service.ts) as "you",
// so it is an activity entry like the agent's.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GoogleServices } from "../src/google/tools.ts";
import { CaseActions, UndoBlockedError, YOU } from "../src/actions/service.ts";
import { DEMO_CALENDAR_NAME, demoCalendarText, loadCalendarAsPerson } from "../src/actions/demo.ts";
import { CaseService, DeleteBlockedError } from "../src/case/service.ts";
import { Channel, DEFAULT_EXTRACTION_EFFORT, Effort } from "../src/domain/claim.ts";
import { OutOfScopeError } from "../src/domain/scope.ts";
import { loadScenarios } from "../src/fixtures/load.ts";
import { IntakeService, InvalidRequestError, ManualClaimInput, NotFoundError } from "../src/intake/service.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { timezoneSettings } from "../src/settings/events.ts";
import { CaseDeletedError, CompactionError, StaleEditError, StoreBusyError, type EventStore } from "../src/store/event-log.ts";
import { settingsRoutes, type ProviderSource, type Route } from "./settings.ts";
import { SecretsBusyError, SecretsFileError } from "../src/model/providers/secrets.ts";
import { NO_PROVIDER_TEXT } from "../src/model/providers/messages.ts";
import { GoogleError } from "../src/google/http.ts";
import { GoogleBusyError } from "../src/google/intents.ts";
import { localDate } from "../src/domain/zone.ts";
import { SETTINGS_BUSY_TEXT, SETTINGS_UNREADABLE_TEXT } from "./auth.ts";
import { UsageRefusedError } from "../src/model/usage.ts";

// `generation` is the case generation the page last read. Every request
// that changes state must carry it, and a write from a page opened before a
// Delete case is refused instead of landing in the empty case. Only GET may
// leave it out. The server checks the host and the request's source before
// it calls the API (see hosts.ts and guard.ts).
export type ApiRequest = { method: string; path: string; body: unknown; generation?: number };
export type ApiResponse = { status: number; body: unknown };

const PastedMessage = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
    channel: Channel,
    from: z.string(),
    received_at: z.string(),
    text: z.string(),
  })
  .strict();

const ExtractBody = z.object({ effort: Effort.default(DEFAULT_EXTRACTION_EFFORT), expectedVersion: z.number().int().nonnegative() }).strict();
const ReviewBody = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();
const OwnReportBody = z.object({ expectedVersion: z.number().int().nonnegative(), answer: z.enum(["yes", "no"]) }).strict();
const ManualBody = z.object({ expectedVersion: z.number().int().nonnegative(), claim: ManualClaimInput }).strict();
const CalendarBody = z
  .object({ name: z.string().trim().min(1).max(200), text: z.string().min(1), expectedVersion: z.number().int().nonnegative() })
  .strict();
const Version = z.number().int().nonnegative();
const AnswerBody = z
  .object({ expectedVersion: Version, choiceId: z.string().min(1).max(200), replyVersion: Version.optional() })
  .strict();
const StartDraftBody = z.object({ expectedVersion: Version, template: z.string().min(1).max(50), slotKey: z.string().min(1).max(50) }).strict();
const NameBody = z.object({ expectedVersion: Version, name: z.string().max(200) }).strict();
const EditDraftBody = z.object({ expectedVersion: Version, text: z.string().max(5000) }).strict();
const SuggestBody = z.object({ expectedVersion: Version, intent: z.string().max(2000).nullable() }).strict();
const DeleteCaseBody = z.object({ expectedVersion: Version, confirmation: z.string().max(20) }).strict();
const ApproveBody = z
  .object({ expectedVersion: Version, confirmedFields: z.array(z.string().max(50)).max(20), confirmClaim: z.boolean().optional() })
  .strict();

const UndoBody = z.object({ expectedVersion: Version, version: Version }).strict();

// `settings`: the provider part of the settings (sprint 10, server/auth.ts).
// `ready`: whether the chosen provider can take a call (J12). Without it
// every model step runs.
// `turnRunning`: whether a chat turn is running, which Delete case waits
// for (0017, fix round 1, R1).
export type ApiOptions = { settings?: ProviderSource; ready?: () => boolean; turnRunning?: () => boolean };

// J12: the routes that call the model. With no provider ready each answers
// 422 provider_not_ready with the fixed sentence, and writes nothing.
const MODEL_ROUTES: readonly RegExp[] = [
  /^\/api\/messages\/([^/]+)\/extract$/,
  /^\/api\/conflicts\/([^/]+)\/explain$/,
  /^\/api\/questions\/next$/,
  /^\/api\/reply\/suggest$/,
];

// The store and the records service, which the MCP server also uses, and
// the Google connection (0012), whose calendar entries undo at Google.
export type AgentAccess = { store: EventStore; records: RecordsService; google?: GoogleServices };

export function createApi(service: IntakeService, kase: CaseService, options: ApiOptions, reply: ReplyService, access: AgentAccess) {
  const scenarios = loadScenarios();
  const { records, store } = access;
  const actions = new CaseActions(store, { intake: service, kase, reply, records, ...(access.google ? { google: access.google } : {}) });

  const routes: Route[] = [
    ["GET", /^\/api\/state$/, () => {
      // Read first, so a write that lands during this read makes the page
      // poll again instead of being missed.
      const live = kase.liveVersion();
      return {
        modelClient: service.modelLabel,
        messages: service.messages(),
        evidence: service.evidence(),
        case: kase.view(),
        caseVersion: kase.caseVersion(),
        generation: kase.generation(),
        erasePending: kase.erasePending(),
        history: kase.history(),
        records: records.appointments({ includeArchived: true }).map((a) => a.record),
        settings: timezoneSettings(store),
        activity: actions.activity(),
        live,
      };
    }],
    // The activity log (0009, design 3) and undo. Undo states the activity
    // version the page saw and answers the new case view.
    ["GET", /^\/api\/activity$/, () => actions.activity()],
    // undoEntry reverses a Google Calendar entry at Google first (0012).
    ["POST", /^\/api\/activity\/([^/]+)\/undo$/, async (m, body) => {
      await actions.undoEntry(YOU, decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion);
      return kase.view();
    }],
    ...settingsRoutes(store, actions, options.settings),
    // G-d: a cheap read the page polls to learn that the app, the MCP server
    // or another tab wrote something.
    // 0016, H1: it also starts a background read of Google Calendar when
    // the copy the schedule's clash checks use is more than a minute old.
    ["GET", /^\/api\/case\/version$/, () => {
      if (access.google?.events && access.google.connection.status().calendar) {
        access.google.events.touch(() => ({ dates: kase.view().slots.map((s) => s.date), today: localDate(new Date().toISOString(), kase.timeZone()) }));
      }
      return kase.liveVersion();
    }],
    ["GET", /^\/api\/fixtures$/, () =>
      scenarios.map((s) => ({
        id: s.id,
        title: s.title,
        messages: s.messages.map(({ expected: _expected, ...m }) => m),
      })),
    ],
    ["GET", /^\/api\/fixtures\/calendar$/, () => ({ name: DEMO_CALENDAR_NAME, text: demoCalendarText() })],
    ["POST", /^\/api\/messages$/, (_m, body) => {
      const input = PastedMessage.parse(body);
      return actions.importMessage(YOU, { ...input, id: input.id ?? `pasted-${randomUUID()}` });
    }],
    ["POST", /^\/api\/messages\/([^/]+)\/extract$/, (m, body) => {
      const { effort, expectedVersion } = ExtractBody.parse(body);
      return actions.extract(YOU, decodeURIComponent(m[1]!), { effort, expectedVersion });
    }],
    ["POST", /^\/api\/messages\/([^/]+)\/manual$/, (m, body) => {
      const { expectedVersion, claim } = ManualBody.parse(body);
      return actions.enterManually(YOU, decodeURIComponent(m[1]!), expectedVersion, claim);
    }],
    // "Record this as your own report?" on an own_report card (0009, D1').
    // `expectedVersion` is the message's version. Answers the message.
    ["POST", /^\/api\/messages\/([^/]+)\/own-report$/, (m, body) => {
      const { expectedVersion, answer } = OwnReportBody.parse(body);
      return actions.recordOwnReport(YOU, decodeURIComponent(m[1]!), answer, expectedVersion);
    }],
    ["POST", /^\/api\/evidence\/([^/]+)\/accept$/, (m, body) =>
      actions.acceptClaim(YOU, decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    ["POST", /^\/api\/evidence\/([^/]+)\/reject$/, (m, body) =>
      actions.rejectClaim(YOU, decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    // "Load the demo" loads the demo calendar through this route. The demo's
    // clinic is in America/Denver, so loading the demo calendar also sets
    // the case to the demo's zone, as an action of the assistant that the
    // person can undo (J5).
    ["POST", /^\/api\/calendar$/, (_m, body) => {
      const { name, text, expectedVersion } = CalendarBody.parse(body);
      loadCalendarAsPerson(actions, store, name, text, expectedVersion);
      return kase.view();
    }],
    ["POST", /^\/api\/conflicts\/([^/]+)\/explain$/, (m, body) =>
      actions.explain(YOU, decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    ["POST", /^\/api\/questions\/next$/, (_m, body) => actions.askNext(YOU, ReviewBody.parse(body).expectedVersion)],
    ["POST", /^\/api\/questions\/([^/]+)\/answer$/, (m, body) => {
      const { expectedVersion, choiceId, replyVersion } = AnswerBody.parse(body);
      return actions.answerQuestion(YOU, decodeURIComponent(m[1]!), choiceId, expectedVersion, replyVersion);
    }],
    // Delete case. App only, with its own typed confirmation. No MCP tool
    // reaches it.
    ["POST", /^\/api\/case\/delete$/, (_m, body) => {
      const { expectedVersion, confirmation } = DeleteCaseBody.parse(body);
      const done = kase.deleteCase(expectedVersion, confirmation, { turnRunning: options.turnRunning });
      // Fix round 2, F4: the stored calendar reads named the erased case's
      // appointments, so they go with it.
      access.google?.events?.clear();
      return done;
    }],
    ["POST", /^\/api\/records\/([^/]+)\/archive$/, (m, body) =>
      actions.archive(YOU, decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    ["POST", /^\/api\/records\/([^/]+)\/unarchive$/, (m, body) =>
      actions.unarchive(YOU, decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    ["POST", /^\/api\/records\/([^/]+)\/undo$/, (m, body) => {
      const { expectedVersion, version } = UndoBody.parse(body);
      return actions.undoRecordEvent(YOU, decodeURIComponent(m[1]!), version, expectedVersion);
    }],
    ["POST", /^\/api\/reply\/suggest$/, (_m, body) => {
      const { expectedVersion, intent } = SuggestBody.parse(body);
      return actions.suggestReply(YOU, intent, expectedVersion);
    }],
    ["POST", /^\/api\/reply\/drafts$/, (_m, body) => {
      const { expectedVersion, template, slotKey } = StartDraftBody.parse(body);
      return actions.startReply(YOU, template, slotKey, expectedVersion);
    }],
    ["POST", /^\/api\/reply\/drafts\/([^/]+)\/edit$/, (m, body) => {
      const { expectedVersion, text } = EditDraftBody.parse(body);
      return actions.editDraft(YOU, decodeURIComponent(m[1]!), text, expectedVersion);
    }],
    // 0016, M2: the name that signs replies, given by the person.
    ["POST", /^\/api\/profile\/name$/, (_m, body) => {
      const { expectedVersion, name } = NameBody.parse(body);
      return actions.giveName(YOU, name, expectedVersion);
    }],
    ["POST", /^\/api\/reply\/drafts\/([^/]+)\/discard$/, (m, body) =>
      actions.discardDraft(YOU, decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    // The simulated send. The person only: no agent or MCP tool reaches it.
    ["POST", /^\/api\/reply\/drafts\/([^/]+)\/approve$/, (m, body) => {
      const { expectedVersion, confirmedFields, confirmClaim } = ApproveBody.parse(body);
      return actions.approveDraft(YOU, decodeURIComponent(m[1]!), confirmedFields, expectedVersion, { confirmClaim });
    }],
  ];

  const handle = async function handle(req: ApiRequest): Promise<ApiResponse> {
    for (const [method, pattern, run] of routes) {
      const match = pattern.exec(req.path);
      if (!match) continue;
      if (req.method !== method) return { status: 405, body: { error: "method_not_allowed" } };
      if (method !== "GET" && !(Number.isSafeInteger(req.generation) && req.generation! >= 0)) {
        return {
          status: 400,
          body: { error: "generation_required", message: "This request does not say which case it was made for. Reload the page and try again. Nothing was saved." },
        };
      }
      if (options.ready && MODEL_ROUTES.some((r) => r.source === pattern.source) && !options.ready()) {
        return { status: 422, body: { error: "provider_not_ready", message: NO_PROVIDER_TEXT } };
      }
      try {
        // One command on the case: every write it makes checks the case
        // generation inside its transaction.
        return { status: 200, body: await kase.inCase(() => run(match, req.body), req.generation) };
      } catch (err) {
        return toErrorResponse(err);
      }
    }
    return { status: 404, body: { error: "not_found" } };
  };
  // Every route's method and path pattern, so a test can call each one.
  return Object.assign(handle, { routes: routes.map(([method, pattern]) => ({ method, pattern })) });
}

export function toErrorResponse(err: unknown): ApiResponse {
  // Hosted mode (0014): the call on the server key was refused before it
  // ran. Nothing was written.
  if (err instanceof UsageRefusedError) return { status: err.code === "credits_exhausted" ? 402 : 503, body: { error: err.code, message: err.userText } };
  if (err instanceof UndoBlockedError) return { status: 409, body: { error: "undo_blocked", message: err.message } };
  // An Undo of a Google Calendar entry (0012): another change for the same
  // appointment is in progress, or Google refused or did not answer. The
  // messages are fixed sentences, never Google's body or a token.
  if (err instanceof DeleteBlockedError) return { status: 409, body: { error: "case_busy", message: err.message } };
  if (err instanceof GoogleBusyError) return { status: 409, body: { error: "google_busy", message: err.message } };
  if (err instanceof GoogleError) {
    const status = err.code === "google_unavailable" || err.code === "google_not_configured" ? 503 : err.code === "google_stale" ? 409 : 502;
    return { status, body: { error: err.code, message: err.message } };
  }
  // The provider settings database (0010): busy in another process, or not
  // readable. Nothing was written.
  if (err instanceof SecretsBusyError) return { status: 503, body: { error: "settings_busy", retryable: true, message: SETTINGS_BUSY_TEXT } };
  if (err instanceof SecretsFileError) return { status: 503, body: { error: "settings_unreadable", message: SETTINGS_UNREADABLE_TEXT } };
  if (err instanceof StaleEditError) {
    return { status: 409, body: { error: "stale_edit", message: err.message, currentVersion: err.currentVersion, current: err.current } };
  }
  if (err instanceof OutOfScopeError) return { status: 422, body: { error: "out_of_scope", message: err.message } };
  if (err instanceof NotFoundError) return { status: 404, body: { error: "not_found", message: err.message } };
  if (err instanceof CaseDeletedError) return { status: 409, body: { error: "case_deleted", message: err.message } };
  if (err instanceof CompactionError) return { status: 503, body: { error: "compaction_incomplete", message: err.message } };
  if (err instanceof StoreBusyError) return { status: 503, body: { error: "busy", message: err.message } };
  if (err instanceof InvalidRequestError) return { status: 422, body: { error: "invalid_request", message: err.message } };
  if (err instanceof z.ZodError) {
    return { status: 400, body: { error: "invalid_body", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
  }
  return { status: 500, body: { error: "server_error", message: "The server could not complete the request." } };
}
