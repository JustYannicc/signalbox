import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { matchThread, threadTurns } from "../context/threadContext.ts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { browsingWire, encodeBrowsingLine } from "./browsing/browsingWire.ts";
import { ThreadBrowsing } from "./browsing/ThreadBrowsing.ts";
import { ThreadSecretRequests } from "./secrets/ThreadSecretRequests.ts";
import { TurnReports } from "./diagnostics/TurnReports.ts";
import type { ThreadLifecycleReceipt, ThreadObjectApi } from "./ThreadDirectory.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import { encodeBatchLine, jsonLine, type ThreadObjectReply, wire } from "./threadWire.ts";
import * as ThreadPulls from "./ThreadPulls.ts";
import * as PullRequestSync from "./pullRequests/PullRequestSync.ts";

// Diagnostic records are plain JSON values already (ISO times, no class instances).
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A thread object's engine answers, given a way to run engine effects. The Durable
 * Object runs them on its own engine; tests run the same code in memory.
 * `afterChange` runs after anything that may have left work for the object
 * (a turn to drive, a summary to deliver); `wakeAt` asks for the alarm by an
 * epoch-ms time (a share that ends on its own).
 */
export const makeThreadObjectApi = (
  run: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | ThreadEngine.ThreadEngine
      | TurnReports
      | ThreadBrowsing
      | ThreadSecretRequests
      | ThreadPulls.ThreadPulls
      | PullRequestSync.PullRequestSync
    >,
  ) => Promise<A>,
  afterChange: () => Promise<void>,
  wakeAt: (at: number) => Promise<void>,
): Omit<
  ThreadObjectApi,
  "previews" | "previewLink" | "browserWatch" | "browserInput" | "browserTrail" | "browserStep"
> => {
  const reply = <A>(
    effect: Effect.Effect<
      A,
      ThreadEngine.ThreadNotFoundError | ThreadEngine.ThreadCommandRejectedError,
      | ThreadEngine.ThreadEngine
      | ThreadBrowsing
      | ThreadPulls.ThreadPulls
      | PullRequestSync.PullRequestSync
    >,
  ): Promise<ThreadObjectReply<A>> =>
    run(
      effect.pipe(
        Effect.map((value): ThreadObjectReply<A> => ({ _tag: "ok", value })),
        Effect.catchTags({
          ThreadNotFoundError: () => Effect.succeed({ _tag: "not_found" } as const),
          ThreadCommandRejectedError: (error) =>
            Effect.succeed({
              _tag: "rejected",
              commandId: error.commandId,
              commandType: error.commandType,
              reason: error.reason,
            } as const),
        }),
      ),
    );
  const engine = ThreadEngine.ThreadEngine;
  return {
    trash: async (actor, input) => {
      const result = await reply(
        engine.use((service) =>
          Effect.map(service.trash(actor, input), (receipt): ThreadLifecycleReceipt => ({
            trashId: receipt.trashId,
            deletedAt: receipt.deletedAt,
            purgeAfter: receipt.purgeAfter,
            state: receipt.state,
          })),
        ),
      );
      await afterChange();
      return result;
    },
    restore: async (actor, input) => {
      const result = await reply(
        engine.use((service) =>
          Effect.map(service.restoreTrash(actor, input.trashId), (receipt) => ({
            trashId: receipt.trashId,
            deletedAt: receipt.deletedAt,
            purgeAfter: receipt.purgeAfter,
            state: receipt.state,
          })),
        ),
      );
      await afterChange();
      return result;
    },
    purge: (actor, input) => reply(engine.use((service) => service.purgeTrash(actor, input))),
    answerSecret: async (actor, input) => {
      const result = await run(
        ThreadSecretRequests.use((service) =>
          service.answer(actor, wire.secretAnswer.decode(input)),
        ).pipe(
          Effect.as(null),
          Effect.catchTags({ SecretRequestError: (error) => Effect.succeed(error.reason) }),
        ),
      );
      await afterChange();
      return result;
    },
    commandOutput: (actor, input) =>
      run(
        engine.use((service) =>
          service.commandOutput(actor, wire.commandOutputInput.decode(input)).pipe(
            Effect.map((stream) =>
              stream.pipe(Stream.map(jsonLine(wire.commandOutputFrame)), Stream.toReadableStream()),
            ),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
      ),
    dispatch: async (actor, command, creation) => {
      const result = await reply(
        engine.use((service) => service.dispatch(actor, wire.command.decode(command), creation)),
      );
      await afterChange();
      return result;
    },
    launch: async (actor, input, creation) => {
      const result = await reply(
        engine.use((service) =>
          Effect.map(
            service.launch(actor, wire.launchInput.decode(input), creation),
            wire.launchResult.encode,
          ),
        ),
      );
      await afterChange();
      return result;
    },
    snapshot: (actor) =>
      reply(engine.use((service) => Effect.map(service.snapshot(actor), wire.snapshot.encode))),
    subscribe: (actor, input) =>
      run(
        engine.use((service) =>
          service.subscribe(actor, wire.subscribeInput.decode(input)).pipe(
            Effect.map((stream) =>
              stream.pipe(Stream.map(encodeBatchLine), Stream.toReadableStream()),
            ),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
      ),
    diagnostics: (actor, key) =>
      run(
        Effect.gen(function* () {
          const { projection } = yield* (yield* engine).snapshot(actor);
          const reports = yield* TurnReports;
          const found =
            key === null
              ? { turns: yield* reports.list(projection) }
              : yield* reports.turn(projection, key);
          return found === null ? null : encodeRecord(found);
        }).pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) })),
      ),
    requestPullRequestSync: (actor, key) =>
      reply(
        engine.use((service) =>
          service.snapshot(actor).pipe(
            Effect.flatMap(({ projection }) => {
              const linked = visibleThreadPullRequests(projection.thread.pullRequests ?? []).some(
                (link) => threadPullRequestKeyOf(link) === key,
              );
              if (!linked) return Effect.fail(new ThreadEngine.ThreadNotFoundError());
              return PullRequestSync.PullRequestSync.use((sync) => sync.requestSync(key)).pipe(
                Effect.tap((at) =>
                  at === null
                    ? Effect.void
                    : Effect.tryPromise(() => wakeAt(at)).pipe(
                        Effect.catch((cause) =>
                          Effect.logError("arming a pull request refresh failed", { cause }),
                        ),
                      ),
                ),
                Effect.asVoid,
              );
            }),
          ),
        ),
      ),
    contextMatch: (actor, terms) =>
      run(
        engine.use((service) =>
          service.snapshot(actor).pipe(
            Effect.map(({ projection }) => matchThread(projection, terms)),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
      ),
    contextTurns: (actor, turn) =>
      run(
        engine.use((service) =>
          service.snapshot(actor).pipe(
            Effect.map(({ projection }) => ({
              title: projection.thread.title,
              projectId: projection.thread.projectId,
              turns: threadTurns(projection, turn),
            })),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
      ),
    setMonitors: async (actor, monitors) => {
      const result = await reply(
        engine.use((service) => service.setMonitors(actor, wire.monitors.decode(monitors))),
      );
      // A new summary revision waits for the alarm's outbox.
      await afterChange();
      return result;
    },
    browsing: (actor, you) =>
      run(
        ThreadBrowsing.use((browsing) =>
          browsing.subscribe(actor, browsingWire.member.decode(you)).pipe(
            Effect.map((stream) =>
              stream.pipe(Stream.map(encodeBrowsingLine), Stream.toReadableStream()),
            ),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
      ),
    browse: (actor, by, command) => {
      const decoded = browsingWire.command.decode(command);
      return reply(
        ThreadBrowsing.use((browsing) =>
          browsing.dispatch(actor, browsingWire.member.decode(by), decoded),
        ).pipe(
          // The alarm ends a share on time, even with nobody connected.
          Effect.tap(({ tab }) => {
            const until = tab?.sharing?.until;
            if (decoded._tag !== "Share" || until == null) return Effect.void;
            // The share already landed; an alarm that failed to arm is re-armed on the next wake.
            return Effect.tryPromise(() =>
              wakeAt(DateTime.toEpochMillis(DateTime.makeUnsafe(until))),
            ).pipe(
              Effect.catch((cause) => Effect.logError("arming a share's end failed", { cause })),
            );
          }),
          Effect.map(browsingWire.dispatched.encode),
          // The browsing log has no command ids; the reason is what the client shows.
          Effect.catchTags({
            BrowsingRejectedError: (error) =>
              Effect.fail(
                ThreadEngine.ThreadCommandRejectedError.forCommand(
                  { id: "", type: decoded._tag },
                  error.reason,
                ),
              ),
          }),
        ),
      );
    },
    browsingRecord: (actor) =>
      reply(
        ThreadBrowsing.use((browsing) =>
          Effect.map(browsing.record(actor), browsingWire.head.encode),
        ),
      ),
    pullOwner: (actor, driveId) =>
      run(ThreadPulls.ThreadPulls.use((pulls) => pulls.owner(actor, driveId))),
    pullTarget: (actor, driveId, operationId, branch) =>
      run(
        ThreadPulls.ThreadPulls.use((pulls) => pulls.target(actor, driveId, operationId, branch)),
      ),
    reservePublication: (actor, driveId, operationId) =>
      reply(
        ThreadPulls.ThreadPulls.use((pulls) =>
          pulls.reservePublication(actor, driveId, operationId),
        ),
      ),
    releasePublication: (actor, driveId, operationId) =>
      run(
        ThreadPulls.ThreadPulls.use((pulls) =>
          pulls.releasePublication(actor, driveId, operationId),
        ),
      ),
    pull: async (actor, input) => {
      const decoded = wire.pullInput.decode(input);
      const begun = await reply(
        ThreadPulls.ThreadPulls.use((pulls) => pulls.begin(actor, decoded)),
      );
      if (begun._tag !== "ok") return begun;
      await afterChange();
      return reply(
        ThreadPulls.ThreadPulls.use((pulls) =>
          Effect.map(pulls.wait(actor, decoded.operationId), wire.pullResult.encode),
        ),
      );
    },
    summary: (actor) =>
      run(
        engine.use((service) =>
          Effect.map(service.summary(actor), (summary) =>
            summary === null ? null : wire.summary.encode(summary),
          ),
        ),
      ),
  };
};
