// @effect-diagnostics abortControllerInEffect:off - per-request publisher and cancellation signals are the inputs under test.
import { describe, expect, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type {
  ExecutorMcpPort,
  HarnessMcpTurnGrantInput,
  HarnessMcpTurnGrantSource,
  TurnAccess,
} from "../../HarnessSessionHost.ts";
import { hostFixture, type Grant } from "../../tests/hostFixture.ts";

const endpoint = "https://tools-gateway.test/mcp";

type Tuple = Omit<HarnessMcpTurnGrantInput, "signal">;
type Issued = { readonly grant: Grant; readonly tuple: Tuple };

const sameTuple = (left: Tuple | undefined, right: Tuple | undefined) =>
  left?.runId === right?.runId &&
  left?.nativeTurnEpoch === right?.nativeTurnEpoch &&
  left?.publisher.generation === right?.publisher.generation &&
  left?.publisher.facetNonce === right?.publisher.facetNonce;

const makeGrantGateway = (now: () => number) => {
  const issued: Issued[] = [];
  let current: Issued | undefined;
  let failNext: "throw" | "unknown" | undefined;
  let onBlockedForward: ((signal: AbortSignal) => void) | undefined;
  let onBlockedIssue: ((signal: AbortSignal) => void) | undefined;
  const source: HarnessMcpTurnGrantSource<Grant> = {
    async issue(input) {
      // Starting a replacement invalidates the prior tuple before issuance can fail.
      current = undefined;
      const blocked = onBlockedIssue;
      if (blocked !== undefined) {
        onBlockedIssue = undefined;
        blocked(input.signal);
        return new Promise<null>(() => undefined);
      }
      if (failNext === "throw") {
        failNext = undefined;
        throw new Error("private grant issuer details");
      }
      if (failNext === "unknown") {
        failNext = undefined;
        return null;
      }
      const tuple: Tuple = {
        runId: input.runId,
        nativeTurnEpoch: input.nativeTurnEpoch,
        publisher: { ...input.publisher },
      };
      const grant: Grant = { secret: `grant-${issued.length + 1}`, claims: tuple };
      const value = { grant, tuple };
      issued.push(value);
      current = value;
      return { grant, endpoint, expiresAtMs: now() + 60_000 };
    },
  };
  const forward: ExecutorMcpPort<Grant>["forward"] = async (input) => {
    const valid =
      input.gatewayEndpoint === endpoint &&
      current !== undefined &&
      input.grant.secret === current.grant.secret &&
      sameTuple(input.grant.claims, current.tuple);
    if (!valid) return new Response("denied", { status: 401 });
    const blocked = onBlockedForward;
    if (blocked !== undefined) {
      onBlockedForward = undefined;
      blocked(input.signal);
      return new Promise<Response>(() => undefined);
    }
    return new Response("gateway", { status: 200 });
  };
  return {
    source,
    forward,
    issued,
    failNext(value: "throw" | "unknown") {
      failNext = value;
    },
    blockNextForward(callback: (signal: AbortSignal) => void) {
      onBlockedForward = callback;
    },
    blockNextIssue(callback: (signal: AbortSignal) => void) {
      onBlockedIssue = callback;
    },
  };
};

const publisherAccess = (
  f: { access: (secret: string, controller?: AbortController) => TurnAccess<Grant> },
  secret: string,
  generation: number,
  facetNonce: string,
  controller?: AbortController,
) => ({
  ...f.access(secret, controller),
  publisher: { generation, facetNonce },
});

const laterTurn = (turn: RunnerTurn, runId: string, ordinal: number) => ({
  ...turn,
  runId: RunId.make(runId),
  attemptId: RunAttemptId.make(`attempt-${ordinal}`),
  runOrdinal: ordinal,
  providerTurnOrdinal: ordinal,
});

describe("Harness host injected per-turn grants", () => {
  it.effect("keeps checkpoint-only access inert until the first grant-bound turn", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const clock = yield* Clock.Clock;
      const gateway = makeGrantGateway(() => clock.currentTimeMillisUnsafe());
      f.setForward(gateway.forward);
      const instance = yield* f.make({ turnGrantSource: gateway.source });
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const session = yield* instance.host.open({
        bootAttemptId: "checkpoint-only",
        session: instance.adapter.input.session,
        checkpoint: instance.checkpoint(),
        initialAccess: f.access("checkpoint-grant"),
      });
      const checkpointConfig = f.configurations[0]!;
      expect(gateway.issued).toHaveLength(0);

      const access = publisherAccess(f, "turn-base", 11, "request-publisher");
      yield* session.turn({ turn: instance.adapter.turn, access });
      yield* instance.adapter.nextStart;
      const turnConfig = f.configurations[1]!;
      expect(gateway.issued).toHaveLength(1);
      expect(turnConfig.epoch).toBeGreaterThan(checkpointConfig.epoch);
      expect(gateway.issued[0]?.tuple).toEqual({
        runId: instance.adapter.turn.runId,
        nativeTurnEpoch: turnConfig.epoch,
        publisher: { generation: 11, facetNonce: "request-publisher" },
      });
      yield* Effect.promise(() =>
        expect(f.mcp.fetch(new Request(checkpointConfig.servers.executor!.url))).rejects.toThrow(),
      );
      const turnResponse = yield* Effect.promise(() =>
        f.mcp.fetch(new Request(turnConfig.servers.executor!.url)),
      );
      expect(turnResponse.status).toBe(200);
      yield* session.dispose;
    }).pipe(Effect.scoped),
  );

  it.effect(
    "binds each real route to the allocated run epoch and publisher, then rejects replaced credentials at the fake gateway",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const clock = yield* Clock.Clock;
        const gateway = makeGrantGateway(() => clock.currentTimeMillisUnsafe());
        f.setForward(gateway.forward);
        const instance = yield* f.make({ turnGrantSource: gateway.source });
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();

        const firstTurn = instance.adapter.turn;
        const firstController = new AbortController();
        const firstAccess = publisherAccess(f, "base-a", 7, "publisher-a", firstController);
        yield* session.turn({ turn: firstTurn, access: firstAccess });
        yield* instance.adapter.nextStart;
        const firstConfig = f.configurations[0]!;
        const firstIssued = gateway.issued[0]!;
        expect(firstIssued.tuple).toEqual({
          runId: firstTurn.runId,
          nativeTurnEpoch: firstConfig.epoch,
          publisher: { generation: 7, facetNonce: "publisher-a" },
        });
        const firstResponse = yield* Effect.promise(() =>
          f.mcp.fetch(new Request(firstConfig.servers.executor!.url)),
        );
        expect(firstResponse.status).toBe(200);
        expect(f.forwards.at(-1)?.gatewayEndpoint).toBe(endpoint);
        expect(f.forwards.at(-1)?.grant).toBe(firstIssued.grant);

        yield* instance.adapter.terminal();
        yield* instance.adapter.saving;
        const secondTurn = laterTurn(firstTurn, "run-two", 2);
        const secondController = new AbortController();
        const secondAccess = publisherAccess(f, "base-b", 8, "publisher-b", secondController);
        yield* session.turn({ turn: secondTurn, access: secondAccess });
        yield* instance.adapter.nextStart;
        const secondConfig = f.configurations[1]!;
        const secondIssued = gateway.issued[1]!;
        expect(secondIssued.grant).not.toBe(firstIssued.grant);
        expect(secondIssued.tuple).toEqual({
          runId: secondTurn.runId,
          nativeTurnEpoch: secondConfig.epoch,
          publisher: { generation: 7, facetNonce: "publisher-a" },
        });
        expect(secondConfig.epoch).toBeGreaterThan(firstConfig.epoch);
        yield* Effect.promise(() =>
          expect(f.mcp.fetch(new Request(firstConfig.servers.executor!.url))).rejects.toThrow(),
        );

        const directGatewayRequest = (
          grant: Grant,
        ): Parameters<ExecutorMcpPort<Grant>["forward"]>[0] => ({
          target: { type: "executor" },
          grant,
          gatewayEndpoint: endpoint,
          request: new Request(endpoint),
          signal: new AbortController().signal,
        });
        const oldGatewayResponse = yield* Effect.promise(() =>
          gateway.forward(directGatewayRequest(firstIssued.grant)),
        );
        expect(oldGatewayResponse.status).toBe(401);
        const tamperedClaims = [
          { ...secondIssued.grant, claims: { ...secondIssued.tuple, runId: "other-run" } },
          {
            ...secondIssued.grant,
            claims: { ...secondIssued.tuple, nativeTurnEpoch: secondConfig.epoch + 1 },
          },
          {
            ...secondIssued.grant,
            claims: {
              ...secondIssued.tuple,
              publisher: { generation: 9, facetNonce: "publisher-c" },
            },
          },
        ];
        for (const grant of tamperedClaims) {
          expect(
            (yield* Effect.promise(() => gateway.forward(directGatewayRequest(grant)))).status,
          ).toBe(401);
        }
        const secondResponse = yield* Effect.promise(() =>
          f.mcp.fetch(new Request(secondConfig.servers.executor!.url)),
        );
        expect(secondResponse.status).toBe(200);
        expect(f.forwards.at(-1)?.grant).toBe(secondIssued.grant);
        yield* session.dispose;
        yield* instance.host.dispose;

        const replacement = yield* f.make({ turnGrantSource: gateway.source });
        yield* replacement.host.seed("assets");
        yield* replacement.host.seed("programs");
        const replacementSession = yield* replacement.open("replacement-boot");
        const replacementTurn = laterTurn(replacement.adapter.turn, "run-replacement", 3);
        yield* replacementSession.turn({
          turn: replacementTurn,
          access: publisherAccess(f, "replacement-base", 8, "publisher-b"),
        });
        yield* replacement.adapter.nextStart;
        const replacementConfig = f.configurations[2]!;
        const replacementIssued = gateway.issued[2]!;
        expect(replacementConfig.epoch).toBe(firstConfig.epoch);
        expect(replacementIssued.tuple).toEqual({
          runId: replacementTurn.runId,
          nativeTurnEpoch: replacementConfig.epoch,
          publisher: { generation: 8, facetNonce: "publisher-b" },
        });
        expect(
          (yield* Effect.promise(() => gateway.forward(directGatewayRequest(firstIssued.grant))))
            .status,
        ).toBe(401);
        expect(
          (yield* Effect.promise(() => gateway.forward(directGatewayRequest(secondIssued.grant))))
            .status,
        ).toBe(401);
        expect(
          (yield* Effect.promise(() =>
            f.mcp.fetch(new Request(replacementConfig.servers.executor!.url)),
          )).status,
        ).toBe(200);
        yield* replacementSession.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "aborts pending grant issuance when its route is retired without publishing a route",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const clock = yield* Clock.Clock;
        const gateway = makeGrantGateway(() => clock.currentTimeMillisUnsafe());
        f.setForward(gateway.forward);
        const instance = yield* f.make({ turnGrantSource: gateway.source });
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const issued = Promise.withResolvers<AbortSignal>();
        gateway.blockNextIssue((signal) => issued.resolve(signal));
        const pending = yield* session
          .turn({
            turn: instance.adapter.turn,
            access: publisherAccess(f, "pending", 12, "pending-publisher"),
          })
          .pipe(Effect.exit, Effect.forkScoped);
        const issueSignal = yield* Effect.promise(() => issued.promise);

        yield* session.dispose;

        expect(issueSignal.aborted).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
        expect(f.configurations).toHaveLength(0);
        expect(f.forwards).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retires an in-flight gateway call and leaves no route after unknown or failed issuance",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const clock = yield* Clock.Clock;
        const gateway = makeGrantGateway(() => clock.currentTimeMillisUnsafe());
        f.setForward(gateway.forward);
        const instance = yield* f.make({ turnGrantSource: gateway.source });
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const firstTurn = instance.adapter.turn;
        const access = publisherAccess(f, "base-a", 3, "publisher-a");
        yield* session.turn({ turn: firstTurn, access });
        yield* instance.adapter.nextStart;
        const firstUrl = f.configurations[0]!.servers.executor!.url;
        const called = Promise.withResolvers<AbortSignal>();
        gateway.blockNextForward((signal) => called.resolve(signal));
        const pending = yield* Effect.promise(() => f.mcp.fetch(new Request(firstUrl))).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        const gatewaySignal = yield* Effect.promise(() => called.promise);
        yield* instance.adapter.terminal();
        yield* instance.adapter.saving;
        expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
        expect(gatewaySignal.aborted).toBe(true);

        const startsBefore = instance.adapter.calls.filter((call) => call === "start").length;
        for (const failure of ["unknown", "throw"] as const) {
          gateway.failNext(failure);
          const failedTurn = laterTurn(firstTurn, `run-${failure}`, f.configurations.length + 1);
          const result = yield* session
            .turn({
              turn: failedTurn,
              access: publisherAccess(f, `base-${failure}`, 4, `publisher-${failure}`),
            })
            .pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          expect(f.configurations).toHaveLength(1);
          expect(gateway.issued).toHaveLength(1);
          expect(instance.adapter.calls.filter((call) => call === "start")).toHaveLength(
            startsBefore,
          );
        }
        const callsBefore = f.forwards.length;
        yield* Effect.promise(() => expect(f.mcp.fetch(new Request(firstUrl))).rejects.toThrow());
        expect(f.forwards).toHaveLength(callsBefore);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );
});
