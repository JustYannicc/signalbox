import { test } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import { createAppServerDriver } from "./AppServerDriver.mjs";
const encode = (x) => new TextEncoder().encode(JSON.stringify(x) + "\n");
function setup() {
  const sent = [];
  let closed = 0;
  return {
    sent,
    get closed() {
      return closed;
    },
    driver: createAppServerDriver({
      sendLine: (line) => sent.push(JSON.parse(line)),
      closeInput: () => closed++,
    }),
  };
}
test("drives the real bridge after ready without reinitializing and keeps stdin open until completion", async () => {
  const p = setup();
  const run = p.driver.run();
  p.driver.write(encode({ method: "signalbox/ready", params: { upstreamVersion: "0.162.1" } }));
  await Promise.resolve();
  NodeAssert.equal(p.sent[0].method, "thread/start");
  NodeAssert.equal(p.closed, 0);
  p.driver.write(encode({ id: p.sent[0].id, result: { thread: { id: "t1" } } }));
  await Promise.resolve();
  NodeAssert.equal(p.sent[1].method, "turn/start");
  NodeAssert.equal(p.sent[1].params.threadId, "t1");
  NodeAssert.equal(p.closed, 0);
  p.driver.write(
    encode({
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn1", status: "completed" } },
    }),
  );
  p.driver.write(encode({ id: p.sent[1].id, result: { turn: { id: "turn1" } } }));
  const result = await run;
  NodeAssert.equal(result.turnId, "turn1");
  NodeAssert.equal(p.closed, 1);
  NodeAssert.deepEqual(
    p.sent.map((x) => x.method),
    ["thread/start", "turn/start"],
  );
});
test("preserves split UTF8 and rejects a failed turn", async () => {
  const p = setup();
  const request = p.driver.request("thread/start", {});
  const bytes = encode({ id: p.sent[0].id, result: { name: "ä" } });
  const split = bytes.indexOf(0xc3) + 1;
  p.driver.write(bytes.subarray(0, split));
  p.driver.write(bytes.subarray(split));
  NodeAssert.deepEqual(await request, { name: "ä" });
  const run = p.driver.run();
  p.driver.write(encode({ method: "signalbox/ready", params: {} }));
  await Promise.resolve();
  p.driver.write(encode({ id: p.sent[1].id, result: { thread: { id: "t1" } } }));
  await Promise.resolve();
  p.driver.write(encode({ id: p.sent[2].id, result: { turn: { id: "bad" } } }));
  p.driver.write(
    encode({
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "bad", status: "failed", error: "bad tool" } },
    }),
  );
  await NodeAssert.rejects(run, /did not complete successfully/);
});
test("propagates startup errors and does not fabricate approval", async () => {
  const p = setup();
  const run = p.driver.run();
  p.driver.write(encode({ method: "signalbox/error", params: { message: "SQLite unavailable" } }));
  await NodeAssert.rejects(run, /SQLite unavailable/);
  NodeAssert.equal(p.closed, 1);
  NodeAssert.equal(p.sent.length, 0);
  const q = setup();
  const waiting = q.driver.wait("ready");
  q.driver.write(
    encode({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} }),
  );
  await NodeAssert.rejects(waiting, /Unexpected server request/);
  NodeAssert.equal(q.sent[0].error.code, -32601);
  NodeAssert.equal(q.closed, 1);
});
test("does not accept completion followed by an error in the same stdout write", async () => {
  const p = setup();
  const run = p.driver.run();
  p.driver.write(encode({ method: "signalbox/ready", params: {} }));
  await Promise.resolve();
  p.driver.write(encode({ id: p.sent[0].id, result: { thread: { id: "t1" } } }));
  await Promise.resolve();
  p.driver.write(encode({ id: p.sent[1].id, result: { turn: { id: "turn1" } } }));
  await Promise.resolve();
  const success = encode({
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "turn1", status: "completed" } },
  });
  const error = encode({ method: "signalbox/error", params: { message: "late error" } });
  const combined = new Uint8Array(success.length + error.length);
  combined.set(success);
  combined.set(error, success.length);
  p.driver.write(combined);
  await NodeAssert.rejects(run, /late error/);
});
