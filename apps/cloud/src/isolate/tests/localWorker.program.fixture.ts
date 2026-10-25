import { NodeWorkerMessagePort, type NodeWorkerThreadsModule } from "../NodeWorkerThreads.ts";

/** A transport fixture. The product host separately owns loading the official hook graph. */
export function runLocalWorkerFixture(
  threads: NodeWorkerThreadsModule,
  signal: AbortSignal,
): Promise<void> {
  const parent = threads.parentPort;
  if (parent === null) throw new Error("The local worker has no parent channel");
  const data: unknown = threads.workerData;
  if (data === null || typeof data !== "object") throw new Error("The worker has no data");
  const stamp: unknown = Reflect.get(data, "stamp");
  const marks: unknown = Reflect.get(data, "marks");
  if (!(stamp instanceof SharedArrayBuffer) || !(marks instanceof SharedArrayBuffer))
    throw new Error("The worker needs real shared memory");
  const stampView = new Int32Array(stamp);
  const marksView = new Int32Array(marks);
  const completed = Promise.withResolvers<void>();
  let port: NodeWorkerMessagePort | undefined;
  const stop = () => completed.resolve();
  signal.addEventListener("abort", stop, { once: true });
  parent.on("message", (frame) => {
    if (frame === null || typeof frame !== "object" || Reflect.get(frame, "type") !== "load")
      throw new Error("Expected a hook load frame");
    const endpoint: unknown = Reflect.get(frame, "port");
    const bytes: unknown = Reflect.get(frame, "bytes");
    if (!(endpoint instanceof NodeWorkerMessagePort) || !(bytes instanceof Uint8Array))
      throw new Error("The hook load frame lost its transferred values");
    port = endpoint;
    port.on("message", (message) => {
      if (message === "finish") {
        port?.postMessage({ type: "terminal", stamp: Atomics.load(stampView, 0) });
        completed.resolve();
        return;
      }
      const parentValue = Atomics.load(marksView, 0);
      Atomics.store(stampView, 0, parentValue + 1);
      Atomics.store(marksView, 1, 73);
      port?.postMessage({ type: "result", message, bytes, parentValue });
    });
    parent.postMessage({ type: "loaded", threadId: threads.threadId });
  });
  return completed.promise.finally(() => {
    signal.removeEventListener("abort", stop);
    parent.removeAllListeners("message");
    port?.removeAllListeners("message");
  });
}
