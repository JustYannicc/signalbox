import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import { EXPECTATIONS, expectedResponseIds } from "./modelPeer.mjs";
import { setup, socketFor, driveTurn, exchange, output, session } from "./model-test-helpers.mjs";

const checkpoint = {
  native: { id: "turn-1", sha256: "native", bytes: 10 },
  filesystem: { id: "turn-1", sha256: "files", bytes: 20 },
};
const verifyPhysicalRecovery = async (input) => {
  NodeAssert.equal(input.nativeSessionId, session);
  NodeAssert.deepEqual(input.checkpoint, checkpoint);
  NodeAssert.deepEqual(input.receipt, {
    from: input.fromIncarnation,
    to: input.toIncarnation,
    checkpoint,
    nativeSessionId: session,
    retirement: "completed",
  });
  return { durable: true, retirementCompleted: true, nativeSessionId: session, checkpoint };
};
const recovery = (fromIncarnation, toIncarnation) => ({
  fromIncarnation,
  toIncarnation,
  nativeSessionId: session,
  checkpoint,
  receipt: {
    from: fromIncarnation,
    to: toIncarnation,
    checkpoint,
    nativeSessionId: session,
    retirement: "completed",
  },
});

async function replacement() {
  const { peer, records } = setup({ verifyPhysicalRecovery });
  peer.beginTurn({ turn: 1, incarnation: "A", prompt: EXPECTATIONS.turns[0].prompt });
  const history = await driveTurn(peer, socketFor(peer), EXPECTATIONS.turns[0]);
  await peer.recordReplacement({
    afterCompletedTurn: 1,
    fromIncarnation: "A",
    toIncarnation: "B",
    nativeSessionId: session,
    receipt: { offlineStub: true },
  });
  peer.prepareIncarnation("B");
  return { peer, history, records };
}

test("physical evictions between turns retain exactly one logical replacement", async () => {
  const { peer, history, records } = await replacement();
  await exchange(socketFor(peer), []);
  await peer.recoverIncarnation(recovery("B", "C"));
  const recoveredC = socketFor(peer);
  await exchange(recoveredC, []);
  peer.beginTurn({ turn: 2, incarnation: "C", prompt: EXPECTATIONS.turns[1].prompt });
  await driveTurn(peer, recoveredC, EXPECTATIONS.turns[1], history);
  await peer.recoverIncarnation(recovery("C", "D"));
  const recoveredD = socketFor(peer);
  await exchange(recoveredD, []);
  peer.beginTurn({ turn: 3, incarnation: "D", prompt: EXPECTATIONS.turns[2].prompt });
  await driveTurn(peer, recoveredD, EXPECTATIONS.turns[2], history);
  const complete = peer.assertComplete();
  NodeAssert.equal(complete.completedTurns, 3);
  NodeAssert.equal(complete.replacements, 1);
  NodeAssert.equal(complete.modelRequests, 20);
  NodeAssert.equal(complete.startupRequests, 3);
  NodeAssert.equal(expectedResponseIds(4).length, 21);
  NodeAssert.equal(complete.toolCalls, 14);
  NodeAssert.equal(complete.toolResults, 14);
  NodeAssert.equal(records.filter((row) => row.kind === "validated_tool_result").length, 14);
  NodeAssert.deepEqual(
    peer.snapshot().physicalIncarnations.map((row) => [row.incarnation, row.logicalIncarnation]),
    [
      ["A", 0],
      ["B", 1],
      ["C", 1],
      ["D", 1],
    ],
  );
  NodeAssert.equal(peer.snapshot().physicalRecoveries.length, 2);
  NodeAssert.equal((await peer.closeAndJoin()).closedSockets, 4);
});

test("mid-turn recovery drains the old sockets before rebinding and preserves action progress", async () => {
  const { peer, history, records } = await replacement();
  peer.beginTurn({ turn: 2, incarnation: "B", prompt: EXPECTATIONS.turns[1].prompt });
  const oldSocket = socketFor(peer);
  await peer.recoverIncarnation(recovery("B", "C"));
  NodeAssert.equal(oldSocket.readyState, 3);
  const beforeOldTraffic = records.length;
  NodeAssert.throws(() => exchange(oldSocket, history), /Socket is closed/);
  NodeAssert.equal(records.length, beforeOldTraffic);
  NodeAssert.equal(peer.failureError, undefined);

  const turn = EXPECTATIONS.turns[1];
  history.push({ role: "user", content: turn.prompt });
  const firstSocket = socketFor(peer);
  const first = await exchange(firstSocket, history);
  history.push(first[1].item, output(turn.actions[0]));
  await peer.recoverIncarnation(recovery("C", "D"));
  NodeAssert.equal(firstSocket.readyState, 3);
  const socket = socketFor(peer);
  const metadata = { session_id: session, thread_id: session, turn_id: "" };
  await exchange(socket, history.slice(0, -3), {
    generate: false,
    client_metadata: {
      ...metadata,
      "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "prewarm" }),
    },
  });
  NodeAssert.equal(
    peer
      .snapshot()
      .records.filter((row) => row.kind === "model_response" && row.outputCallIds?.length).length,
    EXPECTATIONS.turns[0].actions.filter((row) => row.callId).length + 1,
  );
  for (const action of turn.actions.slice(1)) {
    const events = await exchange(socket, history);
    NodeAssert.equal(events[0].response.id, action.responseId);
    history.push(events[1].item);
    if (action.kind !== "assistant_final") history.push(output(action));
  }
  await peer.completeNativeTurn({ turn: 2, receipt: { offlineStub: true } });
  peer.beginTurn({ turn: 3, incarnation: "D", prompt: EXPECTATIONS.turns[2].prompt });
  await driveTurn(peer, socket, EXPECTATIONS.turns[2], history);
  NodeAssert.equal(peer.assertComplete().toolCalls, 14);
  NodeAssert.equal(peer.assertComplete().modelRequests, 18);
  NodeAssert.equal(peer.assertComplete().startupRequests, 1);
  NodeAssert.equal(peer.snapshot().replacementCount, 1);
  NodeAssert.equal(peer.snapshot().physicalRecoveries.length, 2);
  await peer.closeAndJoin();
});

test("recovery before the sole logical replacement does not consume it", async () => {
  const { peer } = setup({ verifyPhysicalRecovery });
  peer.beginTurn({ turn: 1, incarnation: "A", prompt: EXPECTATIONS.turns[0].prompt });
  const history = await driveTurn(peer, socketFor(peer), EXPECTATIONS.turns[0]);
  await peer.recoverIncarnation(recovery("A", "A-recovered"));
  NodeAssert.equal(peer.snapshot().replacementCount, 0);
  await peer.recordReplacement({
    afterCompletedTurn: 1,
    fromIncarnation: "A-recovered",
    toIncarnation: "B",
    nativeSessionId: session,
    receipt: { offlineStub: true },
  });
  peer.prepareIncarnation("B");
  peer.beginTurn({ turn: 2, incarnation: "B", prompt: EXPECTATIONS.turns[1].prompt });
  const socket = socketFor(peer);
  await driveTurn(peer, socket, EXPECTATIONS.turns[1], history);
  peer.beginTurn({ turn: 3, incarnation: "B", prompt: EXPECTATIONS.turns[2].prompt });
  await driveTurn(peer, socket, EXPECTATIONS.turns[2], history);
  NodeAssert.equal(peer.assertComplete().replacements, 1);
  await peer.closeAndJoin();
});

test("a second logical replacement is rejected after physical recovery", async () => {
  const { peer } = await replacement();
  await peer.recoverIncarnation(recovery("B", "C"));
  await NodeAssert.rejects(
    peer.recordReplacement({
      afterCompletedTurn: 1,
      fromIncarnation: "C",
      toIncarnation: "D",
      nativeSessionId: session,
      receipt: { offlineStub: true },
    }),
    /only replacement/,
  );
});

test("prepareIncarnation cannot disguise a second logical replacement during an active turn", async () => {
  const { peer } = await replacement();
  peer.beginTurn({ turn: 2, incarnation: "B", prompt: EXPECTATIONS.turns[1].prompt });
  NodeAssert.throws(
    () => peer.prepareIncarnation("C"),
    /logical incarnation during an active turn/,
  );
});

test("forged physical recovery is rejected before socket transfer", async () => {
  const { peer } = await replacement();
  const socket = socketFor(peer);
  const input = recovery("B", "C");
  input.receipt.retirement = "authorized";
  await NodeAssert.rejects(peer.recoverIncarnation(input));
  NodeAssert.equal(peer.snapshot().preparedIncarnation, "B");
  NodeAssert.equal(socket.readyState, 1);
  NodeAssert.equal(peer.snapshot().physicalRecoveries.length, 0);
  socket.close();
});

test("a recovered physical process still refuses a second startup before resuming progress", async () => {
  const { peer, history } = await replacement();
  peer.beginTurn({ turn: 2, incarnation: "B", prompt: EXPECTATIONS.turns[1].prompt });
  const turn = EXPECTATIONS.turns[1];
  history.push({ role: "user", content: turn.prompt });
  const initial = await exchange(socketFor(peer), history);
  history.push(initial[1].item, output(turn.actions[0]));
  await peer.recoverIncarnation(recovery("B", "C"));
  const socket = socketFor(peer);
  await exchange(socket, []);
  NodeAssert.equal(
    peer
      .snapshot()
      .records.filter((row) => row.kind === "model_response" && row.outputCallIds?.length).length,
    EXPECTATIONS.turns[0].actions.filter((row) => row.callId).length + 1,
  );
  await NodeAssert.rejects(exchange(socket, []));
  NodeAssert.match(peer.failureError.message, /Unexpected or extra empty-input startup/);
  await NodeAssert.rejects(peer.closeAndJoin(), /Unexpected or extra empty-input startup/);
  NodeAssert.equal(peer.activeSockets, 0);
});
