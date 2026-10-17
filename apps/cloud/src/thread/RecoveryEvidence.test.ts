import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { recoveryEvidence } from "./RecoveryEvidence.ts";
import {
  connect,
  freshDatabase,
  launch,
  owner,
  personal,
  threadId,
  withObject,
} from "./runnerTesting.ts";
import { SessionRows } from "./session/SessionRows.ts";

describe("recovery drill evidence", () => {
  it.effect(
    "keeps event and opaque native-row prefixes verifiable across object reconstruction",
    () =>
      Effect.gen(function* () {
        const database = freshDatabase();
        const first = yield* withObject(database, (engine, runner, context) =>
          Effect.gen(function* () {
            yield* launch(engine);
            yield* engine.dispatch(
              owner,
              {
                type: "thread.metadata.update",
                commandId: CommandId.make("disposable-title"),
                threadId,
                title: "recovery-drill/native-prefix",
              },
              personal,
            );
            const machine = yield* connect(runner);
            const sessions = yield* SessionRows;
            yield* sessions.append({
              stream: "claude/session-1",
              offset: 0,
              rows: ['{"type":"thinking","signature":"opaque-signed-reasoning"}'],
            });
            const evidence = yield* recoveryEvidence(owner.userId, ["launch-1"]);
            if (evidence === null) throw new Error("Missing recovery evidence.");
            expect(evidence.receipts[0]?.receipt?._tag).toBe("accepted");
            expect(evidence.lease.generation).toBe(machine.generation);
            expect(evidence.sessions[0]).toMatchObject({ stream: "claude/session-1", count: 1 });
            const serialized = JSON.stringify(evidence);
            expect(serialized).not.toContain(machine.token);
            expect(serialized).not.toContain("opaque-signed-reasoning");
            expect(serialized).not.toContain("Hello Claude");
            return evidence;
          }).pipe(Effect.provide(context)),
        );
        yield* withObject(database, (_engine, _runner, context) =>
          Effect.gen(function* () {
            yield* (yield* SessionRows).append({
              stream: "claude/session-1",
              offset: 1,
              rows: ['{"type":"assistant","text":"after recovery"}'],
            });
            const after = yield* recoveryEvidence(owner.userId, ["launch-1"]);
            if (after === null) throw new Error("Missing reconstructed evidence.");
            expect(after.events).toEqual(first.events);
            expect(after.receipts).toEqual(first.receipts);
            expect(after.lease).toEqual(first.lease);
            expect(after.sessions[0]?.hashes.slice(0, 1)).toEqual(first.sessions[0]?.hashes);
            expect(after.sessions[0]?.count).toBe(2);
          }).pipe(Effect.provide(context)),
        );
      }),
  );

  it.effect("does not expose ordinary threads or another owner's disposable thread", () =>
    withObject(freshDatabase(), (engine, _runner, context) =>
      Effect.gen(function* () {
        expect(yield* recoveryEvidence(owner.userId, [])).toBeNull();
        yield* launch(engine);
        expect(yield* recoveryEvidence(owner.userId, [])).toBeNull();
        yield* engine.dispatch(
          owner,
          {
            type: "thread.metadata.update",
            commandId: CommandId.make("disposable-title"),
            threadId,
            title: "recovery-drill/owned",
          },
          personal,
        );
        expect(yield* recoveryEvidence("another-owner", [])).toBeNull();
        expect(yield* recoveryEvidence(owner.userId, [])).not.toBeNull();
      }).pipe(Effect.provide(context)),
    ),
  );
});
