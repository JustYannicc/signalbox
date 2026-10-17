import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PoolModelApi } from "../pool/PoolDirectory.ts";
import type { ModelForwardReply, ModelPoolRoute } from "./ModelProtocol.ts";
import * as ModelCompletion from "./ModelCompletion.ts";

const pool: ModelPoolRoute = { objectName: "owner:personal", userId: "owner" };

const selection = (
  instanceId: string,
  model: string,
  options?: ModelSelection["options"],
): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
  ...(options === undefined ? {} : { options }),
});

const forwarded = (body: unknown): ModelForwardReply => ({
  _tag: "forwarded",
  response: Response.json(body),
  upstreamMs: 7,
});

const bodyOf = (request: Request) => Effect.promise(() => request.json());

const withCompletion = (
  reply: ModelForwardReply,
  effect: (
    service: ModelCompletion.ModelCompletion["Service"],
  ) => Effect.Effect<unknown, ModelCompletion.ModelCompletionError>,
) => {
  const calls: Array<{
    readonly args: Parameters<PoolModelApi["forwardModel"]>;
    readonly objectName: string;
  }> = [];
  const modelsOf = (objectName: string): PoolModelApi => ({
    forwardModel: (...args) => {
      calls.push({ args, objectName });
      return Promise.resolve(reply);
    },
  });
  return Effect.gen(function* () {
    const service = yield* ModelCompletion.ModelCompletion;
    return { value: yield* effect(service), calls };
  }).pipe(Effect.provide(ModelCompletion.layer(modelsOf)));
};

describe("ModelCompletion", () => {
  it.effect("builds a text-only Anthropic request for a plain Claude instance", () =>
    Effect.gen(function* () {
      const { calls, value } = yield* withCompletion(
        forwarded({
          type: "message",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "A concise answer." }],
          usage: { input_tokens: 12, output_tokens: 6 },
        }),
        (service) =>
          service.complete({
            pool,
            modelSelection: selection("claudeAgent", "claude-sonnet-5-5", [
              { id: "effort", value: "high" },
            ]),
            prompt: "Say something concise.",
          }),
      );

      expect(value).toBe("A concise answer.");
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      const { args, objectName } = call;
      expect(objectName).toBe(pool.objectName);
      expect(args).toHaveLength(3);
      expect(args[0]).toEqual({ userId: pool.userId });
      expect(args[1]).toBe("/v1/messages");
      const request = args[2]!;
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(yield* bodyOf(request)).toEqual({
        model: "claude-sonnet-5-5",
        max_tokens: 4096,
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "Say something concise." }],
      });
    }),
  );

  it.effect("builds a text-only Responses request for a pool Codex instance", () =>
    Effect.gen(function* () {
      const { calls, value } = yield* withCompletion(
        forwarded({
          status: "completed",
          output: [
            {
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: "Generated text." }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 11 },
        }),
        (service) =>
          service.complete({
            pool,
            modelSelection: selection("codex_hub_team", "gpt-6.1-sol", [
              { id: "reasoningEffort", value: "medium" },
            ]),
            prompt: "Write one sentence.",
          }),
      );

      expect(value).toBe("Generated text.");
      expect(calls).toHaveLength(1);
      const { args } = calls[0]!;
      expect(args).toHaveLength(3);
      expect(args[0]).toEqual({ userId: pool.userId });
      expect(args[1]).toBe("/v1/responses");
      const body = yield* bodyOf(args[2]!);
      expect(body).toEqual({
        model: "gpt-6.1-sol",
        max_output_tokens: 4096,
        reasoning: { effort: "medium" },
        input: "Write one sentence.",
      });
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("workspace");
    }),
  );

  it.effect("maps the effort alias to OpenAI reasoning.effort", () =>
    Effect.gen(function* () {
      const { calls } = yield* withCompletion(
        forwarded({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
        }),
        (service) =>
          service.complete({
            pool,
            modelSelection: selection("codex", "gpt-6.1-sol", [{ id: "effort", value: "high" }]),
            prompt: "Finish this.",
          }),
      );

      expect(yield* bodyOf(calls[0]!.args[2]!)).toMatchObject({
        reasoning: { effort: "high" },
      });
    }),
  );

  it.effect("maps OpenAI fast service tier and accepts saved Claude defaults", () =>
    Effect.gen(function* () {
      const openAi = yield* withCompletion(
        forwarded({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
        }),
        (service) =>
          service.complete({
            pool,
            modelSelection: selection("codex", "gpt-6.1-sol", [
              { id: "serviceTier", value: "fast" },
            ]),
            prompt: "Finish this.",
          }),
      );
      expect(yield* bodyOf(openAi.calls[0]!.args[2]!)).toMatchObject({
        service_tier: "priority",
      });

      const claude = yield* withCompletion(
        forwarded({
          type: "message",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        }),
        (service) =>
          service.complete({
            pool,
            modelSelection: selection("claude_hub_team", "claude-sonnet-5-5", [
              { id: "fastMode", value: false },
              { id: "serviceTier", value: "default" },
            ]),
            prompt: "Finish this.",
          }),
      );
      const claudeBody = yield* bodyOf(claude.calls[0]!.args[2]!);
      expect(claudeBody).toMatchObject({
        service_tier: "standard_only",
      });
      expect(claudeBody).not.toHaveProperty("fastMode");
    }),
  );

  it.effect("preserves pool denial and never turns it into a model error reply", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withCompletion({ _tag: "denied", reason: "Pool membership was revoked." }, (service) =>
          service.complete({
            pool,
            modelSelection: selection("codex", "gpt-6.1-sol"),
            prompt: "Hello",
          }),
        ),
      );

      expect(error).toMatchObject({
        _tag: "ModelCompletionError",
        code: "pool-denied",
        reason: "Pool membership was revoked.",
      });
    }),
  );

  it.effect("reports pool and HTTP failures", () =>
    Effect.gen(function* () {
      const poolError = yield* Effect.flip(
        withCompletion({ _tag: "failed", reason: "offline" }, (service) =>
          service.complete({
            pool,
            modelSelection: selection("claudeAgent", "claude-sonnet-5-5"),
            prompt: "Hello",
          }),
        ),
      );
      expect(poolError).toMatchObject({ code: "pool-unavailable" });

      const httpError = yield* Effect.flip(
        withCompletion(
          { _tag: "forwarded", response: new Response("", { status: 429 }), upstreamMs: 2 },
          (service) =>
            service.complete({
              pool,
              modelSelection: selection("codex", "gpt-6.1-sol"),
              prompt: "Hello",
            }),
        ),
      );
      expect(httpError).toMatchObject({
        code: "http-error",
        reason: expect.stringContaining("429"),
      });
    }),
  );

  it.effect("rejects unsupported providers and options before contacting the pool", () =>
    Effect.gen(function* () {
      const unsupportedProvider = yield* Effect.flip(
        withCompletion({ _tag: "failed", reason: "must not be called" }, (service) =>
          service.complete({
            pool,
            modelSelection: selection("scripted", "scripted-echo"),
            prompt: "Hello",
          }),
        ),
      );
      expect(unsupportedProvider).toMatchObject({ code: "unsupported-provider" });

      const unsupportedOption = yield* Effect.flip(
        withCompletion({ _tag: "failed", reason: "must not be called" }, (service) =>
          service.complete({
            pool,
            modelSelection: selection("claudeAgent", "claude-sonnet-5-5", [
              { id: "fastMode", value: true },
            ]),
            prompt: "Hello",
          }),
        ),
      );
      expect(unsupportedOption).toMatchObject({ code: "unsupported-option" });

      const duplicatedEffort = yield* Effect.flip(
        withCompletion({ _tag: "failed", reason: "must not be called" }, (service) =>
          service.complete({
            pool,
            modelSelection: selection("codex", "gpt-6.1-sol", [
              { id: "effort", value: "high" },
              { id: "reasoningEffort", value: "high" },
            ]),
            prompt: "Hello",
          }),
        ),
      );
      expect(duplicatedEffort).toMatchObject({ code: "invalid-options" });
    }),
  );

  it.effect("rejects truncated, failed, tool-only, and empty provider replies", () =>
    Effect.gen(function* () {
      const failures: Array<readonly [ModelForwardReply, ModelSelection, string]> = [
        [
          forwarded({
            type: "message",
            stop_reason: "max_tokens",
            content: [{ type: "text", text: "partial" }],
          }),
          selection("claudeAgent", "claude-sonnet-5-5"),
          "truncated",
        ],
        [
          forwarded({
            status: "failed",
            output: [],
          }),
          selection("codex", "gpt-6.1-sol"),
          "provider-failed",
        ],
        [
          forwarded({
            status: "completed",
            output: [{ type: "function_call", name: "search", arguments: "{}" }],
          }),
          selection("codex", "gpt-6.1-sol"),
          "tool-call",
        ],
        [
          forwarded({
            status: "completed",
            output: [{ type: "message", content: [] }],
          }),
          selection("codex", "gpt-6.1-sol"),
          "no-text",
        ],
        [forwarded({ unexpected: true }), selection("codex", "gpt-6.1-sol"), "invalid-response"],
      ];

      for (const [reply, modelSelection, code] of failures) {
        const error = yield* Effect.flip(
          withCompletion(reply, (service) =>
            service.complete({
              pool,
              modelSelection,
              prompt: "Hello",
            }),
          ),
        );
        expect(error.code).toBe(code);
      }
    }),
  );

  it.effect("accepts only successful Anthropic terminal stops", () =>
    Effect.gen(function* () {
      const { value } = yield* withCompletion(
        forwarded({
          type: "message",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "Done." }],
        }),
        (service) =>
          service.complete({
            pool,
            modelSelection: selection("claudeAgent", "claude-sonnet-5-5"),
            prompt: "Finish this.",
          }),
      );
      expect(value).toBe("Done.");

      const failures: Array<readonly [string | null, string]> = [
        [null, "provider-failed"],
        ["pause_turn", "provider-failed"],
        ["unexpected_stop", "provider-failed"],
        ["refusal", "provider-refused"],
      ];
      for (const [stop_reason, code] of failures) {
        const error = yield* Effect.flip(
          withCompletion(
            forwarded({
              type: "message",
              stop_reason,
              content: [{ type: "text", text: "This text must not escape." }],
            }),
            (service) =>
              service.complete({
                pool,
                modelSelection: selection("claudeAgent", "claude-sonnet-5-5"),
                prompt: "Finish this.",
              }),
          ),
        );
        expect(error.code).toBe(code);
      }
    }),
  );

  it.effect("rejects OpenAI failed or refused messages even when they include text", () =>
    Effect.gen(function* () {
      const failures: Array<readonly [unknown, string]> = [
        [
          {
            status: "completed",
            output: [
              {
                type: "message",
                status: "failed",
                content: [{ type: "output_text", text: "Partial text." }],
              },
            ],
          },
          "provider-failed",
        ],
        [
          {
            status: "completed",
            output: [
              {
                type: "message",
                status: "cancelled",
                content: [{ type: "output_text", text: "Partial text." }],
              },
            ],
          },
          "provider-failed",
        ],
        [
          {
            status: "completed",
            output: [
              {
                type: "message",
                status: "completed",
                content: [
                  { type: "output_text", text: "Partial text." },
                  { type: "refusal", refusal: "I can't help with that." },
                ],
              },
            ],
          },
          "provider-refused",
        ],
      ];

      for (const [body, code] of failures) {
        const error = yield* Effect.flip(
          withCompletion(forwarded(body), (service) =>
            service.complete({
              pool,
              modelSelection: selection("codex", "gpt-6.1-sol"),
              prompt: "Finish this.",
            }),
          ),
        );
        expect(error.code).toBe(code);
      }
    }),
  );
});
