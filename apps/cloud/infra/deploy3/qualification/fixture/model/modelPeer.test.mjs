import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { EXPECTATIONS } from "./modelPeer.mjs";
import { createCombinedCodexModelSocket } from "./modelSocket.mjs";
import {
  Pair,
  setup,
  socketFor,
  exchange,
  output,
  driveTurn,
  session,
} from "./model-test-helpers.mjs";
test("three controlled turns retain full wire records and enforce one replacement", async () => {
  const { peer, records } = setup();
  peer.beginTurn({ turn: 1, incarnation: "A", prompt: EXPECTATIONS.turns[0].prompt });
  const first = socketFor(peer);
  const history = await driveTurn(peer, first, EXPECTATIONS.turns[0]);
  await peer.recordReplacement({
    afterCompletedTurn: 1,
    fromIncarnation: "A",
    toIncarnation: "B",
    nativeSessionId: session,
    receipt: { offlineStub: true },
  });
  peer.prepareIncarnation("B");
  peer.beginTurn({ turn: 2, incarnation: "B", prompt: EXPECTATIONS.turns[1].prompt });
  const second = socketFor(peer);
  await driveTurn(peer, second, EXPECTATIONS.turns[1], history);
  peer.beginTurn({ turn: 3, incarnation: "B", prompt: EXPECTATIONS.turns[2].prompt });
  await driveTurn(peer, second, EXPECTATIONS.turns[2], history);
  const result = peer.assertComplete();
  NodeAssert.equal(result.toolResults, 14);
  NodeAssert.equal(result.modelRequests, 17);
  NodeAssert.equal(records.filter((record) => record.kind === "model_response_frame").length, 51);
  NodeAssert.equal(records.filter((record) => record.kind === "validated_tool_result").length, 14);
  NodeAssert.deepEqual(new Set(records.map((record) => record.incarnation)), new Set(["A", "B"]));
  NodeAssert.equal((await peer.closeAndJoin()).closedSockets, 2);
});

test("future and unknown tool results fail before a model action", async () => {
  for (const callId of ["unknown", EXPECTATIONS.turns[1].actions[0].callId]) {
    const { peer } = setup();
    peer.beginTurn({ turn: 1, incarnation: "A", prompt: EXPECTATIONS.turns[0].prompt });
    const socket = socketFor(peer);
    await NodeAssert.rejects(
      exchange(socket, [
        { role: "user", content: EXPECTATIONS.turns[0].prompt },
        { type: "function_call_output", call_id: callId, output: "unowned" },
      ]),
      /peer failed/,
    );
    NodeAssert.match(peer.failureError.message, /Unlisted|future-turn/);
  }
});

test("changed echoed command arguments fail", async () => {
  const { peer } = setup();
  const turn = EXPECTATIONS.turns[0];
  peer.beginTurn({ turn: 1, incarnation: "A", prompt: turn.prompt });
  const socket = socketFor(peer);
  const input = [{ role: "user", content: turn.prompt }];
  const events = await exchange(socket, input);
  input.push({ ...events[1].item, arguments: "{}" }, output(turn.actions[0]));
  await NodeAssert.rejects(exchange(socket, input), /peer failed/);
  NodeAssert.match(peer.failureError.message, /arguments changed/);
});

test("bounded warmups work once per incarnation and delta history retains the exact prompt", async () => {
  const { peer } = setup();
  const turn = EXPECTATIONS.turns[0];
  peer.beginTurn({ turn: 1, incarnation: "A", prompt: turn.prompt });
  const first = socketFor(peer);
  const warmup = await exchange(first, []);
  NodeAssert.equal(warmup.length, 2);
  let previous;
  const restoredHistory = [{ role: "user", content: turn.prompt }];
  for (let i = 0; i < turn.actions.length; i++) {
    const action = turn.actions[i];
    const input = i === 0 ? restoredHistory : [output(turn.actions[i - 1])];
    const events = await exchange(first, input, previous ? { previous_response_id: previous } : {});
    previous = events[0].response.id;
    restoredHistory.push(events[1].item);
    if (action.kind !== "assistant_final") restoredHistory.push(output(action));
  }
  await peer.completeNativeTurn({ turn: 1, receipt: { offlineStub: true } });
  await peer.recordReplacement({
    afterCompletedTurn: 1,
    fromIncarnation: "A",
    toIncarnation: "B",
    nativeSessionId: session,
    receipt: { offlineStub: true },
  });
  peer.prepareIncarnation("B");
  const second = socketFor(peer);
  NodeAssert.equal((await exchange(second, [])).length, 2);
  peer.beginTurn({ turn: 2, incarnation: "B", prompt: EXPECTATIONS.turns[1].prompt });
  await driveTurn(peer, second, EXPECTATIONS.turns[1], restoredHistory);
  peer.beginTurn({ turn: 3, incarnation: "B", prompt: EXPECTATIONS.turns[2].prompt });
  await driveTurn(peer, second, EXPECTATIONS.turns[2], restoredHistory);
  NodeAssert.equal(peer.assertComplete().startupRequests, 2);
  await peer.closeAndJoin();
});

test("missing native patch tool and wrong command content fail", async () => {
  for (const failure of ["patch-tool-missing", "changed-output"]) {
    const { peer } = setup();
    const turn = EXPECTATIONS.turns[0];
    peer.beginTurn({ turn: 1, incarnation: "A", prompt: turn.prompt });
    const socket = socketFor(peer);
    const input = [{ role: "user", content: turn.prompt }];
    const events = await exchange(socket, input);
    const result = output(turn.actions[0]);
    if (failure === "changed-output")
      result.output = result.output.replace("turn1-command", "wrong-command");
    input.push(events[1].item, result);
    await NodeAssert.rejects(
      exchange(
        socket,
        input,
        failure === "patch-tool-missing" ? { tools: [{ name: "exec_command" }] } : {},
      ),
      /peer failed/,
    );
    NodeAssert.match(
      peer.failureError.message,
      failure === "patch-tool-missing" ? /did not expose native apply_patch/ : /unexpected output/,
    );
  }
});

test("socket disposal waits for the accepted request's persistence job", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let finished = false;
  const socketOwner = createCombinedCodexModelSocket({
    WebSocketPair: Pair,
    ownerForSocket: () => "A",
    onRawRequest: async () => {
      entered.resolve();
      await release.promise;
      finished = true;
      throw new Error("offline cancellation after durable write joined");
    },
    respond: () => {
      throw new Error("must not respond");
    },
  });
  const socket = socketOwner.route({
    request: new Request("http://model.invalid/v1/responses", {
      headers: { upgrade: "websocket" },
    }),
  }).webSocket;
  socket.send(JSON.stringify({ type: "response.create", input: [] }));
  await entered.promise;
  const drained = socketOwner.closeAndJoin();
  release.resolve();
  await drained;
  NodeAssert.equal(finished, true);
});

test("startup before UUID bind and beginTurn records prepared owner, phase, bytes and full frames", async () => {
  const { peer, records } = setup({ bind: false });
  const socket = socketFor(peer);
  const events = await exchange(socket, []);
  NodeAssert.deepEqual(
    events.map((event) => event.type),
    ["response.created", "response.completed"],
  );
  const startup = records.filter(
    (record) => record.startup || record.lifecycle?.startsWith("startup-"),
  );
  NodeAssert.equal(startup.length, 2);
  NodeAssert.equal(startup[0].kind, "model_request");
  NodeAssert.equal(startup[0].incarnation, "A");
  NodeAssert.equal(startup[0].nativeSessionId, null);
  NodeAssert.equal(startup[0].turn, null);
  NodeAssert.equal(startup[0].startupPhase, "before-native-session-bind");
  NodeAssert.equal(startup[1].startupPhase, "startup-before-native-session-bind");
  NodeAssert.equal(records.filter((record) => record.kind === "model_response_frame").length, 2);
  for (const record of records) {
    NodeAssert.equal(record.incarnation, "A");
    NodeAssert.equal(record.byteLengthUtf8, Buffer.byteLength(record.raw));
    NodeAssert.equal(
      record.sha256,
      NodeCrypto.createHash("sha256").update(record.raw).digest("hex"),
    );
  }
  peer.bindNativeSession(session);
  peer.beginTurn({ turn: 1, incarnation: "A", prompt: EXPECTATIONS.turns[0].prompt });
  NodeAssert.equal(
    (await exchange(socket, [{ role: "user", content: EXPECTATIONS.turns[0].prompt }]))[0].response
      .id,
    EXPECTATIONS.turns[0].actions[0].responseId,
  );
  const drain = await peer.closeIncarnationAndJoin("A");
  NodeAssert.equal(drain.socketCount, 1);
  NodeAssert.equal(drain.closedAndJoined, true);
  NodeAssert.equal(peer.activeSockets, 0);
  await peer.closeAndJoin();
});

test("nonempty startup traffic before bind and beginTurn fails closed", async () => {
  for (const bind of [false, true]) {
    const { peer } = setup({ bind });
    const socket = socketFor(peer);
    await NodeAssert.rejects(
      exchange(socket, [{ role: "user", content: EXPECTATIONS.turns[0].prompt }]),
      /peer failed/,
    );
    NodeAssert.match(
      peer.failureError.message,
      bind ? /before root beginTurn/ : /Bind the actual native session UUID/,
    );
  }
});

test("a prepared incarnation cannot perform a second empty startup request", async () => {
  const { peer } = setup({ bind: false });
  const socket = socketFor(peer);
  await exchange(socket, []);
  await NodeAssert.rejects(exchange(socket, []), /peer failed/);
  NodeAssert.match(peer.failureError.message, /Unexpected or extra empty-input startup request/);
  NodeAssert.equal(peer.snapshot().startupCount, 1);
});
