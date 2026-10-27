// JSON API for the UI. Kept free of sockets so tests can call it directly.
// The browser never sees the API key: the model client lives here.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CaseService } from "../src/case/service.ts";
import { Channel, Effort } from "../src/domain/claim.ts";
import { loadScenarios, readFixtureText } from "../src/fixtures/load.ts";
import { IntakeService, InvalidRequestError, ManualClaimInput, NotFoundError } from "../src/intake/service.ts";
import { StaleEditError } from "../src/store/event-log.ts";

export type ApiRequest = { method: string; path: string; body: unknown };
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

const ExtractBody = z.object({ effort: Effort.default("low"), expectedVersion: z.number().int().nonnegative() }).strict();
const ReviewBody = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();
const ManualBody = z.object({ expectedVersion: z.number().int().nonnegative(), claim: ManualClaimInput }).strict();
const CalendarBody = z
  .object({ name: z.string().trim().min(1).max(200), text: z.string().min(1), expectedVersion: z.number().int().nonnegative() })
  .strict();
const AnswerBody = z.object({ expectedVersion: z.number().int().nonnegative(), choiceId: z.string().min(1).max(200) }).strict();

export type ApiOptions = { mode: "recorded" | "live" };

export function createApi(service: IntakeService, kase: CaseService, options: ApiOptions) {
  const scenarios = loadScenarios();

  const routes: Array<[string, RegExp, (m: RegExpExecArray, body: unknown) => Promise<unknown> | unknown]> = [
    ["GET", /^\/api\/state$/, () => ({
      mode: options.mode,
      modelClient: service.modelLabel,
      messages: service.messages(),
      evidence: service.evidence(),
      case: kase.view(),
    })],
    ["GET", /^\/api\/fixtures$/, () =>
      scenarios.map((s) => ({
        id: s.id,
        title: s.title,
        messages: s.messages.map(({ expected: _expected, ...m }) => m),
      })),
    ],
    ["GET", /^\/api\/fixtures\/calendar$/, () => ({ name: "dana.ics", text: readFixtureText("calendar/dana.ics") })],
    ["POST", /^\/api\/messages$/, (_m, body) => {
      const input = PastedMessage.parse(body);
      return service.importMessage({ ...input, id: input.id ?? `pasted-${randomUUID()}` });
    }],
    ["POST", /^\/api\/messages\/([^/]+)\/extract$/, (m, body) => {
      const { effort, expectedVersion } = ExtractBody.parse(body);
      return service.extract(decodeURIComponent(m[1]!), { effort, expectedVersion });
    }],
    ["POST", /^\/api\/messages\/([^/]+)\/manual$/, (m, body) => {
      const { expectedVersion, claim } = ManualBody.parse(body);
      return service.enterManually(decodeURIComponent(m[1]!), expectedVersion, claim);
    }],
    ["POST", /^\/api\/evidence\/([^/]+)\/accept$/, (m, body) =>
      service.accept(decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    ["POST", /^\/api\/evidence\/([^/]+)\/reject$/, (m, body) =>
      service.reject(decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    ["POST", /^\/api\/calendar$/, (_m, body) => {
      const { name, text, expectedVersion } = CalendarBody.parse(body);
      return kase.loadCalendar(name, text, expectedVersion);
    }],
    ["POST", /^\/api\/conflicts\/([^/]+)\/explain$/, (m, body) =>
      kase.explain(decodeURIComponent(m[1]!), ReviewBody.parse(body).expectedVersion),
    ],
    ["POST", /^\/api\/questions\/next$/, (_m, body) => kase.askNext(ReviewBody.parse(body).expectedVersion)],
    ["POST", /^\/api\/questions\/([^/]+)\/answer$/, (m, body) => {
      const { expectedVersion, choiceId } = AnswerBody.parse(body);
      return kase.answer(decodeURIComponent(m[1]!), choiceId, expectedVersion);
    }],
  ];

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    for (const [method, pattern, run] of routes) {
      const match = pattern.exec(req.path);
      if (!match) continue;
      if (req.method !== method) return { status: 405, body: { error: "method_not_allowed" } };
      try {
        return { status: 200, body: await run(match, req.body) };
      } catch (err) {
        return toErrorResponse(err);
      }
    }
    return { status: 404, body: { error: "not_found" } };
  };
}

function toErrorResponse(err: unknown): ApiResponse {
  if (err instanceof StaleEditError) {
    return { status: 409, body: { error: "stale_edit", message: err.message, currentVersion: err.currentVersion, current: err.current } };
  }
  if (err instanceof NotFoundError) return { status: 404, body: { error: "not_found", message: err.message } };
  if (err instanceof InvalidRequestError) return { status: 422, body: { error: "invalid_request", message: err.message } };
  if (err instanceof z.ZodError) {
    return { status: 400, body: { error: "invalid_body", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
  }
  return { status: 500, body: { error: "server_error", message: "The server could not complete the request." } };
}
