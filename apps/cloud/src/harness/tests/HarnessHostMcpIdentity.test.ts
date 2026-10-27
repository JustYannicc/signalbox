import { describe, expect, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { TurnAccess } from "../HarnessSessionHost.ts";
import { hostFixture, type Grant } from "./hostFixture.ts";

const connection = (id: string, name: string, directTools = ["read"]) => ({
  id,
  name,
  directTools,
});
const withConnections = (
  access: TurnAccess<Grant>,
  servers: TurnAccess<Grant>["connections"]["servers"],
) => ({
  ...access,
  connections: { servers },
});

describe("Harness host MCP incarnation endpoints", () => {
  it.effect(
    "retains captured destinations through server reordering and current permission changes",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const firstAccess = withConnections(f.access("grant-1"), [
          connection("a", "A"),
          connection("b", "B"),
        ]);
        yield* session.turn({ turn: instance.adapter.turn, access: firstAccess });
        yield* instance.adapter.nextStart;
        const first = f.configurations[0]!;
        const capturedA = first.servers.A!.url;
        yield* instance.adapter.terminal();
        yield* instance.adapter.saving;

        const secondAccess = withConnections(f.access("grant-2"), [
          connection("b", "B"),
          connection("a", "A", ["write"]),
        ]);
        const secondTurn = {
          ...instance.adapter.turn,
          runId: RunId.make("run-2"),
          attemptId: RunAttemptId.make("attempt-2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        };
        yield* session.turn({ turn: secondTurn, access: secondAccess });
        yield* instance.adapter.nextStart;
        const second = f.configurations[1]!;
        expect(second.servers.A!.url).toBe(capturedA);
        expect(second.servers.B!.url).toBe(first.servers.B!.url);
        yield* Effect.promise(() => f.mcp.fetch(new Request(capturedA)));
        expect(f.forwards.at(-1)?.grant).toBe(secondAccess.grant);
        expect(f.forwards.at(-1)?.target).toEqual({
          type: "direct",
          serverId: "a",
          tools: ["write"],
        });
        instance.adapter.setSaveGate(Promise.resolve());
        yield* instance.adapter.terminal(secondTurn);
        yield* instance.adapter.saving;

        const thirdAccess = withConnections(f.access("grant-3"), [connection("other", "A")]);
        yield* session.turn({
          turn: {
            ...instance.adapter.turn,
            runId: RunId.make("run-3"),
            attemptId: RunAttemptId.make("attempt-3"),
            runOrdinal: 3,
            providerTurnOrdinal: 3,
          },
          access: thirdAccess,
        });
        yield* instance.adapter.nextStart;
        const third = f.configurations[2]!;
        expect(third.servers.A!.url).not.toBe(capturedA);
        const count = f.forwards.length;
        yield* Effect.promise(() => expect(f.mcp.fetch(new Request(capturedA))).rejects.toThrow());
        expect(f.forwards).toHaveLength(count);
        yield* Effect.promise(() => f.mcp.fetch(new Request(third.servers.A!.url)));
        expect(f.forwards.at(-1)?.target).toEqual({
          type: "direct",
          serverId: "other",
          tools: ["read"],
        });
        expect(f.forwards.at(-1)?.grant).toBe(thirdAccess.grant);
        expect(f.acquisitions).toHaveLength(1);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a stopped incarnation after a late turn and replacement grant", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const old = yield* f.make();
      yield* old.host.seed("assets");
      yield* old.host.seed("programs");
      const oldSession = yield* old.open();
      yield* oldSession.turn({ turn: old.adapter.turn, access: f.access("old") });
      yield* old.adapter.nextStart;
      const oldMcp = f.mcp;
      const oldUrl = f.configurations[0]!.servers.executor!.url;
      yield* oldSession.dispose;
      yield* old.host.dispose;
      expect(
        Exit.isFailure(
          yield* oldSession
            .turn({ turn: old.adapter.turn, access: f.access("late") })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(f.configurations).toHaveLength(1);

      const replacement = yield* f.make();
      yield* replacement.host.seed("assets");
      yield* replacement.host.seed("programs");
      const next = yield* replacement.open("replacement");
      const replacementAccess = f.access("new");
      yield* next.turn({ turn: replacement.adapter.turn, access: replacementAccess });
      yield* replacement.adapter.nextStart;
      const newUrl = f.configurations[1]!.servers.executor!.url;
      expect(newUrl).not.toBe(oldUrl);
      const count = f.forwards.length;
      yield* Effect.promise(() => expect(oldMcp.fetch(new Request(oldUrl))).rejects.toThrow());
      yield* Effect.promise(() => expect(f.mcp.fetch(new Request(oldUrl))).rejects.toThrow());
      expect(f.forwards).toHaveLength(count);
      yield* Effect.promise(() => f.mcp.fetch(new Request(newUrl)));
      expect(f.forwards.at(-1)?.grant).toBe(replacementAccess.grant);
      yield* next.dispose;
    }).pipe(Effect.scoped),
  );
});
