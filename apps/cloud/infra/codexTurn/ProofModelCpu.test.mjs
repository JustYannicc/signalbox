import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { modelCpuChunk, observeProofSocket } from "./ProofModelCpu.mjs";

NodeTest.test("the work checksum matches an independent integer recurrence", () => {
  let expected = 1n;
  for (let index = 0; index < 10_000; index++)
    expected = (expected * 1664525n + 1013904223n) % (1n << 32n);
  NodeAssert.equal(modelCpuChunk(1, 10_000), Number(expected));
});

NodeTest.test("the native frame waits for work before ACK and guest delivery", async () => {
  const socket = new EventTarget();
  const actions = [];
  socket.send = (value) => actions.push(value);
  const work = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  const observed = observeProofSocket(socket, {
    async receive() {
      actions.push("receive");
      await work.promise;
      actions.push("work-complete");
    },
  });
  const frame = { type: "response.created", response: { id: "fixture" } };
  observed.addEventListener("message", (event) => {
    actions.push("guest");
    delivered.resolve(event.data);
  });
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  NodeAssert.deepEqual(actions, ["receive"]);
  work.resolve();
  NodeAssert.equal(await delivered.promise, JSON.stringify(frame));
  NodeAssert.deepEqual(actions, ["receive", "work-complete", "signalbox-proof-frame-ack", "guest"]);
});

NodeTest.test("a completed response does not send an unsolicited pacing ACK", async () => {
  const socket = new EventTarget();
  const sent = [];
  socket.send = (value) => sent.push(value);
  const delivered = Promise.withResolvers();
  const observed = observeProofSocket(socket, { receive: async () => {} });
  observed.addEventListener("message", () => delivered.resolve());
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ type: "response.completed" }),
    }),
  );
  await delivered.promise;
  NodeAssert.deepEqual(sent, []);
});
