import { describe, expect, it } from "vite-plus/test";
import { createCaptureFlush } from "./captureFlush";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("capture shutdown flush", () => {
  it("joins voice stop and the final file snapshot before waiting for storage commit", async () => {
    const stopped = deferred<Uint8Array>();
    const preparing = deferred<void>();
    const committing = deferred<void>();
    const committed = deferred<void>();
    const events: string[] = [];
    let savedBytes: Uint8Array | null = null;
    const flush = createCaptureFlush(async () => {
      events.push("commit");
      committing.resolve();
      await committed.promise;
    });
    flush.register(async () => {
      events.push("stop");
      preparing.resolve();
      savedBytes = await stopped.promise;
      events.push("snapshot");
    });
    let acknowledged = false;
    const first = flush.run();
    const second = flush.run();
    expect(second).toBe(first);
    const done = first.then(() => {
      acknowledged = true;
    });
    await preparing.promise;
    expect(acknowledged).toBe(false);
    expect(events).toEqual(["stop"]);
    stopped.resolve(new Uint8Array([1, 2, 255]));
    await committing.promise;
    expect(savedBytes).toEqual(new Uint8Array([1, 2, 255]));
    expect(acknowledged).toBe(false);
    committed.resolve();
    await done;
    expect(acknowledged).toBe(true);
    expect(events).toEqual(["stop", "snapshot", "commit"]);
  });

  it("rejects a failed snapshot and allows a fresh retry without acknowledging it", async () => {
    let attempts = 0;
    let commits = 0;
    const flush = createCaptureFlush(async () => {
      commits += 1;
    });
    flush.register(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
    });
    await expect(flush.run()).rejects.toThrow("disk full");
    expect(commits).toBe(0);
    await flush.run();
    expect(commits).toBe(1);
  });
});
