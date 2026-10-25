import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

const testLayer = Layer.mergeAll(
  EventSink.layer,
  ProjectionMaintenance.layer,
  EffectOutbox.layer,
).pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const now = DateTime.makeUnsafe("2026-10-17T00:00:00.000Z");
const threadId = ThreadId.make("canonical-item-rebuild");
const instanceId = ProviderInstanceId.make("codex");
const finalCommandOutput = `${"line\n".repeat(15_000)}SERVER_CANONICAL_TAIL\n`;
const create: OrchestrationV2DomainEvent = {
  id: EventId.make("create-thread"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: {
    id: threadId,
    projectId: ProjectId.make("synthetic-project"),
    title: "Synthetic history",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "synthetic" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
};
function item(index: number, id = "first"): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`${id}:${index}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(id),
      type: "command_execution",
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: index === 99 ? "completed" : "running",
      title: "Synthetic command",
      input: "echo synthetic",
      output: index === 99 ? finalCommandOutput : "line\n".repeat(index + 1),
      ...(index === 99 ? { outputTruncated: true } : {}),
      startedAt: now,
      completedAt: index === 99 ? now : null,
      updatedAt: now,
    },
  };
}

it.effect(
  "publishes all updates, rebuilds identical state, and preserves command receipts and pending effects",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const effects = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      yield* sink.write({ events: [create] });
      const commandId = CommandId.make("first-item-command");
      const command = {
        commandId,
        threadId,
        commandType: "synthetic.item",
        acceptedAt: now,
        events: [item(0)],
        effects: [
          {
            id: "synthetic-effect",
            commandId,
            threadId,
            request: { type: "terminal.cleanup" as const },
          },
        ],
      };
      const original = yield* sink.commitCommand(command);
      const pull = yield* Stream.toPull(
        sink.stream({ threadId, afterSequence: original.receipt.resultSequence - 1 }),
      );
      assert.deepEqual(yield* pull, original.storedEvents);
      const second = yield* sink.write({ events: [item(0, "second")] });
      assert.deepEqual(yield* pull, second);
      for (let index = 1; index < 100; index++) {
        const committed = yield* sink.write({ events: [item(index)] });
        assert.deepEqual(yield* pull, committed);
      }
      const before = yield* projection.getThreadProjection(threadId);
      const fullCommand = yield* projection.getTurnItem({
        threadId,
        itemId: TurnItemId.make("first"),
      });
      assert.isTrue(fullCommand?.type === "command_execution");
      if (fullCommand?.type !== "command_execution") return;
      assert.equal(fullCommand.output, finalCommandOutput);
      assert.isTrue(fullCommand.outputTruncated);
      const wireCommand = projectTurnItemForWire(fullCommand);
      assert.isTrue(
        wireCommand.type === "command_execution" && wireCommand.outputTruncated === true,
      );
      assert.isFalse("output" in wireCommand);
      assert.deepEqual(
        before.turnItems.map((row) => row.id),
        ["first", "second"],
      );
      const head = yield* sink.latestSequence({ threadId });
      const retry = yield* sink.commitCommand(command);
      assert.isFalse(retry.committed);
      assert.deepEqual(retry.receipt, original.receipt);
      assert.equal(yield* sink.latestSequence({ threadId }), head);
      assert.equal((yield* effects.listByCommandId(commandId)).length, 1);
      const claimed = yield* effects.claimNext({
        workerId: "synthetic-worker",
        leaseDurationMs: 1000,
      });
      assert.isTrue(Option.isSome(claimed));
      assert.equal(Option.getOrThrow(claimed).id, "synthetic-effect");
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* projection.getThreadProjection(threadId), before);
      assert.deepEqual(
        yield* projection.getTurnItem({ threadId, itemId: fullCommand.id }),
        fullCommand,
      );
      assert.equal(yield* sink.latestSequence({ threadId }), head);
      assert.deepEqual(
        yield* sql`SELECT ordinal FROM orchestration_v2_turn_item_positions ORDER BY ordinal`,
        [{ ordinal: 1 }, { ordinal: 2 }],
      );
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type = 'turn-item.updated'`,
        [{ count: 101 }],
      );
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM signalbox_turn_item_state`, [
        { count: 2 },
      ]);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
);
