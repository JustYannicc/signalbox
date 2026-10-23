import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

it("runs a local worker load frame with real shared memory and transferred ports", async () => {
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: "1396-local-worker-test",
          main: NodeURL.fileURLToPath(new URL("./localWorker.root.fixture.ts", import.meta.url)),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat"],
        },
      },
    ],
  });
  try {
    await harness.listen();
    const response = await harness.fetch("http://proof/", { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({
      detached: true,
      oldHandleDetached: true,
      load: { type: "loaded", threadId: 1 },
      messages: [
        { type: "result", message: "dispatch", bytes: { 0: 0, 1: 127, 2: 255 }, parentValue: 41 },
        { type: "terminal", stamp: 42 },
      ],
      sharedWrites: [42, 73],
      exit: 0,
      threadId: -1,
      online: ["online"],
      order: ["entry loaded", "entry joined", "callbacks fenced"],
      ports: 0,
    });
  } finally {
    await harness.close();
  }
}, 60_000);
