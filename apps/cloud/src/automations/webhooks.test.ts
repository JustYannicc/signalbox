import { AUTOMATION_WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { hookTestSetup, HOOK_USER, signedBody } from "./hookTesting.ts";
import { sameToken, verifySignature, type HookRequest } from "./webhookRequest.ts";

const secret = "test-hook-signing-secret";
const source = `export const meta = { name: "Receive a webhook", triggers: [{ webhook: {
  signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" }
} }] } as const;
export default workflow(async (_w, input: unknown) => input);`;

describe("cloud webhooks", () => {
  it("accepts GitHub's published test vector and rejects altered bytes and missing signatures", async () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex",
      prefix: "sha256=",
    } as const;
    const request = {
      headers: {
        "x-hub-signature-256":
          "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      },
      body: new TextEncoder().encode("Hello, World!"),
    };
    expect(await verifySignature(signature, "It's a Secret to Everybody", request)).toBe(true);
    expect(
      await verifySignature(signature, "It's a Secret to Everybody", {
        ...request,
        body: new TextEncoder().encode("Hello, World?"),
      }),
    ).toBe(false);
    expect(
      await verifySignature(signature, "It's a Secret to Everybody", { ...request, headers: {} }),
    ).toBe(false);
    expect(await sameToken("token-a", "token-a")).toBe(true);
    expect(await sameToken("token-b-longer", "token-a")).toBe(false);
  });

  it.effect(
    "persists a signed delivery before acknowledgement and starts one run after two deliveries",
    () =>
      Effect.gen(function* () {
        const { cloud, user, save, rpc, engine } = yield* hookTestSetup();
        const automation = yield* save(source);
        yield* rpc[AUTOMATION_WS_METHODS.automationsSetWebhookSecret]({
          automationId: automation.id,
          secret,
        });
        const endpoint = automation.webhook!.url!;
        const [hookId, token] = endpoint.split("/").slice(-2);
        const body = '{"message":"München 🦉"}';
        const signature = yield* Effect.promise(() => signedBody(body, secret));
        const request: HookRequest = {
          hookId: hookId!,
          token: token!,
          method: "POST",
          query: "",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": signature,
            "x-github-delivery": "delivery-1",
          },
          body: new TextEncoder().encode(body),
        };
        expect(
          yield* user.receiveHook({
            ...request,
            headers: { ...request.headers, "x-hub-signature-256": "sha256=bad" },
          }),
        ).toEqual({ status: 401 });
        expect((yield* engine((engine) => engine.get(automation.id))).runs).toHaveLength(0);
        const first = yield* user.receiveHook(request);
        const duplicate = yield* user.receiveHook(request);
        expect(first).toMatchObject({ status: 202, duplicate: false });
        expect(duplicate).toEqual({ ...first, duplicate: true });
        expect(cloud.alarmAt(HOOK_USER)).toBeDefined();
        expect((yield* engine((engine) => engine.get(automation.id))).runs).toHaveLength(0);
        yield* cloud.fireAlarm(HOOK_USER);
        yield* cloud.settle;
        const detail = yield* engine((engine) => engine.get(automation.id));
        expect(detail.runs).toHaveLength(1);
        const run = yield* engine((engine) => engine.getRun(detail.runs[0]!.id));
        expect([run.run.status, run.output]).toEqual(["succeeded", { message: "München 🦉" }]);
        expect(yield* user.receiveHook(request)).toEqual({ ...first, duplicate: true });
        yield* cloud.fireAlarm(HOOK_USER);
        expect((yield* engine((engine) => engine.get(automation.id))).runs).toHaveLength(1);
        const rotated = yield* rpc[AUTOMATION_WS_METHODS.automationsRotateWebhook]({
          automationId: automation.id,
        });
        expect(rotated.webhook?.url).not.toBe(endpoint);
        expect(yield* user.receiveHook(request)).toEqual({ status: 404 });
      }),
  );

  it.effect("w.hook wakes only its own run with the request body, then stops answering", () =>
    Effect.gen(function* () {
      const { cloud, user, save, rpc, engine } = yield* hookTestSetup();
      const automation = yield* save(`export const meta = { name: "Callback" } as const;
export default workflow(async (w) => {
  const link = await w.hook("Make a callback");
  const event = await w.waitFor("Wait for the callback", { on: "hook.called", where: { hookId: link.hookId } });
  return event.body;
});`);
      const first = yield* rpc[AUTOMATION_WS_METHODS.automationsRunNow]({
        automationId: automation.id,
      });
      const second = yield* rpc[AUTOMATION_WS_METHODS.automationsRunNow]({
        automationId: automation.id,
      });
      yield* cloud.settle;
      const waiting = yield* engine((engine) => engine.getRun(first.id));
      const link = waiting.steps.find((step) => step.verb === "hook")!.result as {
        hookId: string;
        url: string;
      };
      const request: HookRequest = {
        hookId: link.hookId,
        token: link.url.split("/").at(-1)!,
        method: "POST",
        query: "token=hide&value=42",
        headers: { "content-type": "application/json", "idempotency-key": "callback-1" },
        body: new TextEncoder().encode('{"paid":true}'),
      };
      expect(yield* user.receiveHook(request)).toMatchObject({ status: 202 });
      yield* cloud.fireAlarm(HOOK_USER);
      yield* cloud.settle;
      expect((yield* engine((engine) => engine.getRun(first.id))).output).toEqual({ paid: true });
      expect((yield* engine((engine) => engine.getRun(second.id))).run.status).toBe("running");
      expect(yield* user.receiveHook(request)).toEqual({ status: 404 });
      yield* rpc[AUTOMATION_WS_METHODS.automationsCancelRun]({ runId: second.id });
    }),
  );
});
