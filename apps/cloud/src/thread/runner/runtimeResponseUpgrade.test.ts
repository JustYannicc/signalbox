import { CommandId, NodeId, RuntimeRequestId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { approvalRequestEvents } from "../runtimeRequests.ts";
import { applyEvents } from "../threadProjection.ts";

import { ThreadStore } from "../ThreadStore.ts";
import {
  freshDatabase,
  hello,
  launch,
  liveTurn,
  turnReport,
  owner,
  personal,
  snapshot,
  runtimeResponseUpgrade,
  threadId,
  withObject,
} from "../runnerTesting.ts";

describe("native answer Runner upgrades", () => {
  it.effect(
    "keeps cloud egress approvals on an old Runner while native callbacks still require an upgrade",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const first = (yield* runner.reconcile).ensure!;
          yield* runner.hello({
            ...hello(first.generation, first.token),
            runtimeResponses: false,
            takenRunIds: [],
          });
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: first.generation,
            sequence: 1,
            items: [report.started],
          });
          const store = Context.get(context, ThreadStore);
          const projection = (yield* snapshot(engine)).projection;
          const run = projection.runs[0]!;
          const requestId = RuntimeRequestId.make("cloud-secret-send");
          const events = approvalRequestEvents(
            projection,
            run,
            {
              requestId,
              title: "Send a secret?",
              prompt: "Send KEY to example.com?",
              appName: "Secrets",
              options: [{ label: "Send this turn", decision: "accept" }],
            },
            { now: projection.updatedAt },
          );
          if (events === null) throw new Error("expected cloud approval events");
          const pending = applyEvents(projection, events)!;
          const lease = yield* store.machine;
          expect(runtimeResponseUpgrade(lease, pending, pending.runs[0], 0, 1)).toEqual({
            type: "none",
          });
          const request = pending.runtimeRequests.find((request) => request.id === requestId)!;
          const nativeNodeId = NodeId.make("native-callback-node");
          const root = pending.nodes.find((node) => node.id === request.nodeId)!;
          const native = {
            ...pending,
            nodes: [
              ...pending.nodes,
              { ...root, id: nativeNodeId, parentNodeId: root.id, runtimeRequestId: requestId },
            ],
            runtimeRequests: [{ ...request, nodeId: nativeNodeId }],
          };
          expect(runtimeResponseUpgrade(lease, native, native.runs[0], 0, 1).type).toBe("drain");
          const nativeRoot = {
            ...pending,
            turnItems: pending.turnItems.map((item) =>
              item.type === "approval_request" && item.requestId === requestId
                ? { ...item, id: TurnItemId.make("native-root-permission-card") }
                : item,
            ),
          };
          expect(runtimeResponseUpgrade(lease, nativeRoot, nativeRoot.runs[0], 0, 1).type).toBe(
            "drain",
          );
        }),
      ),
  );

  it.effect.each(["light", "heavy"] as const)(
    "updates an old %s Runner once, saving before its generation changes",
    (machineClass) =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* engine.dispatch(
            owner,
            {
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("supervised"),
              threadId,
              runtimeMode: "approval-required",
            },
            personal,
          );
          const first = (yield* runner.reconcile).ensure!;
          const store = Context.get(context, ThreadStore);
          yield* store.saveMachine({ ...(yield* store.machine), machineClass });
          const oldHello = {
            ...hello(first.generation, first.token),
            runtimeResponses: false,
            takenRunIds: [],
          };
          yield* runner.hello(oldHello);
          expect(yield* runner.work).toMatchObject({ needsUpkeep: true, turn: null });
          const drain = yield* runner.reconcile;
          expect(drain.drain?.generation).toBe(first.generation);
          expect(drain.ensure).toBeNull();
          expect((yield* runner.reconcile).ensure).toBeNull();
          yield* runner.batch({
            generation: first.generation,
            sequence: 1,
            items: [{ kind: "machine.drained", id: drain.drain!.id, unsaved: [] }],
          });
          const upgraded = yield* runner.reconcile;
          expect(upgraded.ensure?.generation).toBe(first.generation + 1);
          expect(upgraded.release).toBe(first.generation);
          expect(upgraded.machineClass).toBe(machineClass);
          const next = upgraded.ensure!;
          // An old image even after the update stays visible, rather than bumping forever.
          yield* runner.hello({ ...oldHello, generation: next.generation, token: next.token });
          expect((yield* runner.work).needsUpkeep).toBe(true);
          expect((yield* runner.reconcile).ensure).toBeNull();
          expect((yield* runner.work).needsUpkeep).toBe(false);
          expect((yield* store.machine).generation).toBe(next.generation);
          expect((yield* runner.work).turn).toBeNull();
          expect((yield* snapshot(engine)).projection.turnItems).toContainEqual(
            expect.objectContaining({
              type: "system_notice",
              runId: (yield* snapshot(engine)).projection.runs[0]!.id,
              message:
                "This machine couldn't update to support questions and approvals. Stop this turn and wait for the machine to shut down before retrying.",
            }),
          );
          const blockedHead = (yield* snapshot(engine)).head;
          yield* runner.reconcile;
          expect((yield* snapshot(engine)).head).toBe(blockedHead);
          // The upgraded process may reconnect after its new image is available.
          yield* runner.hello({ ...hello(next.generation, next.token), takenRunIds: [] });
          expect((yield* runner.work).turn).not.toBeNull();
          expect((yield* runner.reconcile).ensure).toBeNull();
          expect((yield* store.machine).generation).toBe(next.generation);
          expect(yield* runner.hello(oldHello)).toMatchObject({ reason: "stale_generation" });
        }),
      ),
  );
});
