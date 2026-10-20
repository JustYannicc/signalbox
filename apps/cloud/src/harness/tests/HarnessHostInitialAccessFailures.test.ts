import { describe, expect, it } from "@effect/vitest";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { hostFixture } from "./hostFixture.ts";

describe("Harness initial access failures and load requests", () => {
  it.effect.each([
    { label: "reserved name", servers: [{ id: "connection", name: "executor", directTools: [] }] },
    {
      label: "duplicate IDs",
      servers: [
        { id: "connection", name: "one", directTools: [] },
        { id: "connection", name: "two", directTools: [] },
      ],
    },
    {
      label: "duplicate names",
      servers: [
        { id: "one", name: "connection", directTools: [] },
        { id: "two", name: "connection", directTools: [] },
      ],
    },
    { label: "empty ID", servers: [{ id: "", name: "connection", directTools: [] }] },
    { label: "empty name", servers: [{ id: "connection", name: "", directTools: [] }] },
    { label: "empty tool", servers: [{ id: "connection", name: "connection", directTools: [""] }] },
  ] as const)(
    "rejects checkpoint connections with $label before admission and permits a corrected retry",
    ({ servers }) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const access = f.access("opaque-initial-grant");
        const input = {
          bootAttemptId: "invalid-connections",
          session: instance.adapter.input.session,
          checkpoint: instance.checkpoint(),
          initialAccess: { ...access, connections: { servers } },
        };
        expect(Exit.isFailure(yield* instance.host.open(input).pipe(Effect.exit))).toBe(true);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
        expect(f.computers).toHaveLength(0);
        expect(f.acquisitions).toHaveLength(0);
        expect(f.configurations).toHaveLength(0);
        const session = yield* instance.host.open({ ...input, initialAccess: access });
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
        expect(f.acquisitions).toHaveLength(1);
        expect(instance.adapter.calls).toContain("resume");
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect.each(["missing", "aborted"] as const)(
    "rejects %s checkpoint access before claiming or acquiring a runtime",
    (invalid) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const controller = new AbortController();
        const input = {
          bootAttemptId: "invalid-access",
          session: instance.adapter.input.session,
          checkpoint: instance.checkpoint(),
          initialAccess: f.access("opaque-initial-grant", controller),
        };
        if (invalid === "missing") Reflect.deleteProperty(input, "initialAccess");
        else controller.abort("opaque-initial-grant");
        const exit = yield* instance.host.open(input).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).not.toContain("opaque-initial-grant");
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
        expect(f.computers).toHaveLength(0);
        expect(f.acquisitions).toHaveLength(0);
        expect(f.configurations).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["abort", "configuration", "resume"] as const)(
    "retires initial routes and fails open on %s failure",
    (failure) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const gate = yield* Deferred.make<void>();
        if (failure === "abort") f.setConfigureGate(Deferred.await(gate));
        if (failure === "configuration") f.failConfiguration();
        if (failure === "resume") instance.adapter.setResumeFailure();
        const controller = new AbortController();
        const opening = yield* instance.host
          .open({
            bootAttemptId: "failed-checkpoint",
            session: instance.adapter.input.session,
            checkpoint: instance.checkpoint(),
            initialAccess: f.access("opaque-initial-grant", controller),
          })
          .pipe(Effect.exit, Effect.forkScoped);
        const config = yield* f.nextConfiguration;
        if (failure === "abort") controller.abort("opaque-initial-grant");
        const exit = yield* Fiber.join(opening);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).not.toContain("opaque-initial-grant");
          expect(Cause.pretty(exit.cause)).not.toContain("opaque-grant-secret");
        }
        expect(instance.adapter.calls).not.toContain("start");
        if (failure !== "resume") expect(instance.adapter.calls).not.toContain("resume");
        expect(f.configurationSignals[0]?.aborted).toBe(true);
        const forwards = f.forwards.length;
        yield* Effect.promise(() =>
          expect(f.mcp.fetch(new Request(config.servers.executor!.url))).rejects.toThrow(),
        );
        expect(f.forwards).toHaveLength(forwards);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
        yield* Deferred.succeed(gate, undefined);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["ensureThread", "resumeThread"] as const)(
    "supplies the accepted fresh turn's exact %s request to configuration",
    (method) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const turn: RunnerTurn = {
          ...instance.adapter.turn,
          modelSelection: { ...instance.adapter.turn.modelSelection, model: "turn-model" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          providerThread:
            method === "ensureThread"
              ? instance.adapter.turn.providerThread
              : instance.checkpoint().snapshot.providerThread,
        };
        yield* session.turn({ turn, access: f.access("grant") });
        yield* instance.adapter.nextStart;
        const policy = {
          ...instance.adapter.input.session.runtimePolicy,
          runtimeMode: turn.runtimeMode,
          interactionMode: turn.interactionMode,
        };
        expect(f.configurationLoads).toEqual([
          method === "ensureThread"
            ? {
                method,
                input: {
                  threadId: turn.threadId,
                  providerSessionId: instance.adapter.runtime.providerSessionId,
                  modelSelection: turn.modelSelection,
                  runtimePolicy: policy,
                  existingProviderThread: turn.providerThread,
                },
              }
            : {
                method,
                input: {
                  providerThread: turn.providerThread,
                  threadId: turn.threadId,
                  modelSelection: turn.modelSelection,
                  runtimePolicy: policy,
                },
              },
        ]);
        expect(f.configurationSignals[0]?.aborted).toBe(false);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );
});
