import { expect, it } from "@effect/vitest";
import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";

import * as AutomationHttp from "./http.ts";
import { WorkflowEngine, type WorkflowEngineShape } from "./WorkflowEngine.ts";

const ORIGIN = "http://127.0.0.1:5733";

type WebhookInput = Parameters<WorkflowEngineShape["startFromWebhook"]>[0];

function webhookHandler(
  answer: (input: WebhookInput) => ReturnType<WorkflowEngineShape["startFromWebhook"]>,
) {
  const received: WebhookInput[] = [];
  const engine = Layer.mock(WorkflowEngine)({
    validate: () => ({ ok: false, diagnostics: [] }),
    startFromWebhook: (input) => {
      received.push(input);
      return answer(input);
    },
  });
  const routes = AutomationHttp.layer.pipe(
    HttpRouter.provideRequest(engine),
    Layer.provide(engine),
  );
  return { received, ...HttpRouter.toWebHandler(routes, { disableLogger: true }) };
}

const post = (path: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", ...init });

it.effect("starts a run with the parsed body, safe headers and the raw body", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      webhookHandler((input) =>
        Effect.succeed(
          input.token === "hook_live"
            ? { runId: "run_1", duplicate: input.requestKey === "dup" }
            : null,
        ),
      ),
    ),
    ({ handler, received }) =>
      Effect.promise(async () => {
        const started = await handler(
          post("/api/automations/hooks/hook_live", {
            headers: {
              "content-type": "application/json",
              "X-GitHub-Event": "push",
              "X-Request-Id": "delivery-1",
              cookie: "session=secret",
              authorization: "Bearer secret",
            },
            body: '{"ref":"main"}',
          }),
        );
        expect(started.status).toBe(202);
        expect(await started.json()).toEqual({ runId: "run_1" });
        expect(received[0]).toMatchObject({
          token: "hook_live",
          payload: { ref: "main" },
          rawBody: '{"ref":"main"}',
          requestKey: "delivery-1",
        });
        expect(received[0]?.headers?.["x-github-event"]).toBe("push");
        expect(received[0]?.headers).not.toHaveProperty("cookie");
        expect(received[0]?.headers).not.toHaveProperty("authorization");

        const repeated = await handler(
          post("/api/automations/hooks/hook_live", { headers: { "idempotency-key": "dup" } }),
        );
        expect(await repeated.json()).toEqual({ runId: "run_1", duplicate: true });

        const unknown = await handler(post("/api/automations/hooks/hook_gone", { body: "hi" }));
        expect(unknown.status).toBe(404);
      }),
    ({ dispose }) => Effect.promise(dispose),
  ),
);

it.effect("refuses bodies over 1 MB, declared or streamed, before starting anything", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => webhookHandler(() => Effect.succeed({ runId: "run_1", duplicate: false }))),
    ({ handler, received }) =>
      Effect.promise(async () => {
        const declared = await handler(
          post("/api/automations/hooks/hook_live", {
            headers: { "content-length": String(2 * 1024 * 1024) },
            body: "small",
          }),
        );
        expect(declared.status).toBe(413);
        const chunk = new Uint8Array(256 * 1024);
        const streamed = await handler(
          post("/api/automations/hooks/hook_live", {
            body: new ReadableStream({
              start(controller) {
                for (let index = 0; index < 5; index++) controller.enqueue(chunk);
                controller.close();
              },
            }),
            duplex: "half",
          } as RequestInit),
        );
        expect(streamed.status).toBe(413);
        expect(received).toEqual([]);
      }),
    ({ dispose }) => Effect.promise(dispose),
  ),
);

it.effect("answers 500 when the run couldn't be stored", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      webhookHandler(() =>
        Effect.fail(new AutomationError({ message: "Automation storage failed (insertRun)." })),
      ),
    ),
    ({ handler }) =>
      Effect.promise(async () => {
        const failed = await handler(post("/api/automations/hooks/hook_live", { body: "{}" }));
        expect(failed.status).toBe(500);
        expect(await failed.text()).toBe("Couldn't start the automation.");
      }),
    ({ dispose }) => Effect.promise(dispose),
  ),
);
