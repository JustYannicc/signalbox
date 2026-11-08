import { expect, it, vi } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { productCodeModeFixture } from "./productCodeModeFixture.ts";

vi.mock("evlog", () => ({ log: { warn: vi.fn() } }));
vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("delivers the result needed by release while product drain still joins the held permit", async () => {
  const stop = Promise.withResolvers<void>();
  const releasing = Promise.withResolvers<void>();
  const resultReceived = Promise.withResolvers<void>();
  const releaseSawResult = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  let activeCells = () => 0;
  let drained = false;
  const acquire = ChildWorkerCapacity.prototype.acquire;
  const spy = vi.spyOn(ChildWorkerCapacity.prototype, "acquire").mockImplementation(async function (
    this: ChildWorkerCapacity,
    signal,
    requester,
    request,
  ) {
    const permit = await acquire.call(this, signal, requester, request);
    if (!this.owner.endsWith("/code-mode")) return permit;
    activeCells = () => this.active;
    return {
      ...permit,
      async release() {
        releasing.resolve();
        await resultReceived.promise;
        releaseSawResult.resolve();
        await release.promise;
        await permit.release();
        order.push("released");
      },
    };
  });
  const fixture = await productCodeModeFixture({
    code: { mainModule: "unused.js", modules: {} },
    onLifecycle: (event) => order.push(event.type),
    cells: {
      async run(_input, events) {
        await events.started();
        await stop.promise;
        await events.stopped();
        return { terminated: false, error: null, writes: {} };
      },
    },
  });
  try {
    const initial = await fixture.execute("");
    expect(JSON.stringify(initial)).toContain('"Yielded"');
    stop.resolve();
    await releasing.promise;
    const waited = await fixture.request({
      method: "session/wait",
      sessionId: "s1",
      request: { cell_id: "1", yield_time_ms: 0 },
    });
    expect(await waited.response).toMatchObject({
      result: { value: { outcome: { LiveCell: { Result: { error_text: null } } } } },
    });
    expect(order).toEqual(["started", "closed"]);
    order.push("result");
    const signalling = fixture.child.signal(15);
    const draining = fixture.computer.drain().then(() => {
      drained = true;
      order.push("drained");
    });
    resultReceived.resolve();
    await releaseSawResult.promise;
    expect(drained).toBe(false);
    expect(activeCells()).toBe(1);
    release.resolve();
    await Promise.all([signalling, draining]);
    expect(activeCells()).toBe(0);
    expect(order).toEqual(["started", "closed", "result", "released", "drained"]);
  } finally {
    stop.resolve();
    resultReceived.resolve();
    release.resolve();
    await fixture.close();
    spy.mockRestore();
  }
});
