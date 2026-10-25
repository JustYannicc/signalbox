import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { hostFixture } from "./hostFixture.ts";

describe("Harness checkpoint initial access", () => {
  it.effect("configures before eager resume and reuses the configuration for the first turn", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const instance = yield* f.make();
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const gate = yield* Deferred.make<void>();
      f.setConfigureGate(Deferred.await(gate));
      const checkpoint = instance.checkpoint();
      const access = f.access("initial-grant");
      let opened = false;
      const opening = yield* instance.host
        .open({
          bootAttemptId: "checkpoint-1",
          session: instance.adapter.input.session,
          checkpoint,
          initialAccess: access,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              opened = true;
            }),
          ),
          Effect.forkScoped,
        );
      const config = yield* f.nextConfiguration;
      expect(opened).toBe(false);
      expect(f.acquisitions).toHaveLength(1);
      expect(instance.adapter.calls).not.toContain("resume");
      expect(instance.adapter.calls).not.toContain("start");
      expect(f.configurationLoads).toEqual([
        {
          method: "resumeThread",
          input: {
            providerThread: checkpoint.snapshot.providerThread,
            threadId: instance.adapter.input.session.threadId,
            modelSelection: instance.adapter.input.session.modelSelection,
            runtimePolicy: instance.adapter.input.session.runtimePolicy,
          },
        },
      ]);
      yield* Deferred.succeed(gate, undefined);
      const session = yield* Fiber.join(opening);
      expect(instance.adapter.calls.filter((call) => call === "resume")).toHaveLength(1);
      expect(f.configurationSignals[0]?.aborted).toBe(false);
      expect((yield* session.export()).snapshot.providerThread.nativeThreadRef?.nativeId).toBe(
        "native-thread",
      );
      yield* session.turn({ turn: instance.adapter.turn, access });
      yield* instance.adapter.nextStart;
      expect(f.configurations).toEqual([config]);
      expect(f.configurationLoads).toHaveLength(1);
      expect(instance.adapter.calls.filter((call) => call === "resume")).toHaveLength(1);
      yield* Effect.promise(() => f.mcp.fetch(new Request(config.servers.executor!.url)));
      expect(f.forwards.at(-1)?.grant).toBe(access.grant);
      yield* session.dispose;
      expect(f.configurationSignals[0]?.aborted).toBe(true);
      yield* Effect.promise(() =>
        expect(f.mcp.fetch(new Request(config.servers.executor!.url))).rejects.toThrow(),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each(["grant", "signal", "connections"] as const)(
    "rejects changed initial %s on duplicate open and first turn without rotating routes",
    (field) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const original = f.access("accepted-grant");
        const access = {
          ...original,
          connections: {
            servers: original.connections.servers.map((server) => ({
              ...server,
              directTools: [...server.directTools],
            })),
          },
        };
        const input = {
          bootAttemptId: "checkpoint-1",
          session: instance.adapter.input.session,
          checkpoint: instance.checkpoint(),
          initialAccess: access,
        };
        const session = yield* instance.host.open(input);
        const config = f.configurations[0]!;
        if (field === "grant") access.grant = { secret: "changed-grant" };
        if (field === "signal") access.signal = new AbortController().signal;
        if (field === "connections")
          access.connections.servers[0]!.directTools.push("changed-tool");
        expect(Exit.isFailure(yield* instance.host.open(input).pipe(Effect.exit))).toBe(true);
        expect(
          Exit.isFailure(
            yield* session.turn({ turn: instance.adapter.turn, access }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(f.acquisitions).toHaveLength(1);
        expect(f.configurations).toEqual([config]);
        expect(instance.adapter.calls).not.toContain("start");
        yield* Effect.promise(() => f.mcp.fetch(new Request(config.servers.executor!.url)));
        expect(f.forwards.at(-1)?.grant).toBe(original.grant);
        access.grant = original.grant;
        access.signal = original.signal;
        access.connections = {
          servers: original.connections.servers.map((server) => ({
            ...server,
            directTools: [...server.directTools],
          })),
        };
        expect(yield* instance.host.open(input)).toBe(session);
        yield* session.turn({ turn: instance.adapter.turn, access });
        expect(f.configurations).toHaveLength(1);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "snapshots initial connections while keeping grant and signal out of durable input",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const grant = {
          secret: "opaque-initial-grant",
          toJSON() {
            throw new Error("Initial grant must not be serialized");
          },
        };
        const original = f.access("unused");
        const access = {
          ...original,
          grant,
          connections: {
            servers: original.connections.servers.map((server) => ({
              ...server,
              directTools: [...server.directTools],
            })),
          },
        };
        const accepted = {
          ...access,
          connections: {
            servers: access.connections.servers.map((server) => ({
              ...server,
              directTools: [...server.directTools],
            })),
          },
        };
        const reading = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        f.setProgramReadGate(() => {
          reading.resolve();
          return release.promise;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
        const opening = yield* instance.host
          .open({
            bootAttemptId: "checkpoint-snapshot",
            session: instance.adapter.input.session,
            checkpoint: instance.checkpoint(),
            initialAccess: access,
          })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => reading.promise);
        access.connections.servers[0]!.name = "mutated-server";
        access.connections.servers[0]!.directTools.push("mutated-tool");
        release.resolve();
        const session = yield* Fiber.join(opening);
        const config = f.configurations[0]!;
        expect(Object.keys(config.servers)).toEqual(["executor", "normal-server"]);
        expect(f.configurationSignals[0]?.aborted).toBe(false);
        expect(JSON.stringify(f.handle.rows("SELECT * FROM harness_boot_attempts"))).not.toContain(
          grant.secret,
        );
        expect(JSON.stringify(f.configurations)).not.toContain(grant.secret);
        yield* session.turn({ turn: instance.adapter.turn, access: accepted });
        yield* Effect.promise(() => f.mcp.fetch(new Request(config.servers["normal-server"]!.url)));
        expect(f.forwards.at(-1)?.grant).toBe(grant);
        expect(f.forwards.at(-1)?.target).toEqual({
          type: "direct",
          serverId: "normal-server-id",
          tools: ["direct_tool"],
        });
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );
});
