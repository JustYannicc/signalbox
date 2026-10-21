import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeAssert from "node:assert/strict";
import { launchNodeHarnessProcess } from "../../NodeHarnessProcess.ts";
import { deferred, fixture } from "./fixture.ts";

const f = fixture();
const originalFetch = globalThis.fetch;
const port = NodeWorkerThreads.parentPort;
NodeAssert.ok(port);
let dnsSettled = false;
const dnsStarted = deferred<AbortSignal>();
const modelStarted = deferred<AbortSignal>();
const releaseDns = deferred<void>();
const releaseModel = deferred<void>();
const guestDone = deferred<void>();
const dnsDone = deferred<void>();
const modelDone = deferred<void>();
globalThis.fetch = async (_resource, init) => {
  NodeAssert.ok(init?.signal);
  dnsStarted.resolve(init.signal);
  await releaseDns.promise;
  dnsSettled = true;
  dnsDone.resolve();
  throw init.signal.reason;
};
try {
  const process = launchNodeHarnessProcess({
    ...f.input,
    nativeModules: {},
    loadPackages: async () => ({}),
    modelTransport: async (request) => {
      modelStarted.resolve(request.signal);
      await releaseModel.promise;
      modelDone.resolve();
      throw request.signal.reason;
    },
    loadRelease: async (bridge) => ({
      launch() {
        const promises = bridge.require("dns/promises");
        const dns: Promise<unknown> = Reflect.get(promises, "resolve4")("example.test");
        // @effect-diagnostics-next-line globalFetch:off - Exercise the guest fetch installed by the public Node launcher.
        const model = globalThis.fetch("https://model.test/request");
        void Promise.allSettled([dns, model]).then((results) => {
          NodeAssert.equal(results[0]?.status, "rejected");
          if (results[0]?.status === "rejected")
            NodeAssert.equal(results[0].reason.code, "ECANCELLED");
          NodeAssert.equal(results[1]?.status, "rejected");
          guestDone.resolve();
        });
      },
    }),
  });
  const [dnsSignal, modelSignal] = await Promise.all([dnsStarted.promise, modelStarted.promise]);
  let disposed = false;
  const disposing = process.dispose().then(() => {
    NodeAssert.equal(dnsSettled, true, "Process disposal completed before DNS transport settled");
    disposed = true;
  });
  NodeAssert.equal(dnsSignal.aborted, true);
  NodeAssert.equal(modelSignal.aborted, true);
  releaseModel.resolve();
  await modelDone.promise;
  await Promise.resolve();
  NodeAssert.equal(disposed, false);
  port.once("message", () => releaseDns.resolve());
  port.postMessage("release DNS");
  await dnsDone.promise;
  await disposing;
  await guestDone.promise;
  NodeAssert.equal(disposed, true);
} finally {
  releaseDns.resolve();
  releaseModel.resolve();
  port.close();
  globalThis.fetch = originalFetch;
  await f.close();
}
