import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { serializeHarnessFailure } from "../../Harness.ts";
import { fixtureForDriver } from "./fixture.ts";

describe("Claude CLI startup failure journal", () => {
  it.effect("publishes one failed turn and retains the original rejection as its cause", () =>
    Effect.gen(function* () {
      const f = yield* fixtureForDriver(ProviderDriverKind.make("claudeAgent"));
      const startGate = yield* Deferred.make<void>();
      f.setStartGate(Deferred.await(startGate));
      const opened = yield* f.open();
      const starting = yield* opened.session.turn(f.turn).pipe(Effect.exit, Effect.forkScoped);
      yield* f.nextStart;

      const secret = "startup-secret-123456";
      const cause = Object.assign(new Error(`CLI rejected Bearer ${secret}`), {
        name: "CliInitializationError",
      });
      cause.stack =
        `CliInitializationError: CLI rejected Bearer ${secret}\n` +
        "    at initialize (/runtime/cli.js:1:1)";
      f.reportCliStartupFailure(cause);
      f.reportCliStartupFailure(cause);

      expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
      const streamExit = yield* Fiber.join(opened.collector);
      expect(Exit.isFailure(streamExit)).toBe(true);

      const records = opened.events.filter((item) => item.kind === "log");
      expect(records).toHaveLength(1);
      const diagnostic = records[0]?.kind === "log" ? JSON.parse(records[0].message) : undefined;
      expect(diagnostic).toMatchObject({
        type: "harness.cli-startup-failure",
        code: "CLAUDE_CLI_STARTUP_REJECTED",
      });
      expect(records[0]?.kind === "log" ? records[0].message : "").not.toContain(secret);

      const terminals = opened.events.filter(
        (item) => item.kind === "provider" && item.event.type === "turn.terminal",
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        kind: "provider",
        runId: f.turn.runId,
        event: {
          type: "turn.terminal",
          status: "failed",
          failure: { code: "CLAUDE_CLI_STARTUP_REJECTED" },
        },
      });
      if (!Exit.isFailure(streamExit)) throw new Error("Expected stream failure");
      const reason = streamExit.cause.reasons.find((entry) => entry._tag === "Fail");
      if (reason === undefined) throw new Error("Expected a typed startup failure");
      expect(reason.error.cause).toBe(cause);
      expect(serializeHarnessFailure(reason.error)).toMatchObject({
        code: "CLAUDE_CLI_STARTUP_REJECTED",
        message: "Claude CLI startup rejected.",
        cause: { name: "CliInitializationError", message: cause.message, stack: cause.stack },
      });
    }).pipe(Effect.scoped),
  );
});
