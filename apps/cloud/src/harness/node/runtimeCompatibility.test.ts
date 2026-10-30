import { describe, expect, it } from "vite-plus/test";
import {
  createNodeWorkerThreads,
  NodeWorkerPortBroker,
  type NodeWorkerModuleLoader,
  type NodeWorkerSupervisor,
  type NodeWorkerThreadContext,
} from "../../isolate/NodeWorkerThreads.ts";
import { launchNodeHarnessProcess } from "../NodeHarnessProcess.ts";
import { fixture } from "./tests/fixture.ts";

describe("Node harness runtime compatibility", () => {
  it("checks the host-owned worker failure at result and process completion", async () => {
    const f = fixture();
    const broker = new NodeWorkerPortBroker();
    const owner = "compatibility-host";
    let nextThreadId = 1;
    const moduleLoader: NodeWorkerModuleLoader = {
      reference: {
        artifactRef: "fixture:runtime-compatibility",
        artifactHash: "a".repeat(64),
        sourceIdentity: "fixture",
      },
      resolve: (filename) => (filename instanceof URL ? filename.href : filename),
    };
    const supervisor: NodeWorkerSupervisor = {
      start: async () => {
        throw new Error("No worker should start in the process compatibility test");
      },
    };
    const context: NodeWorkerThreadContext = {
      ports: {
        owner,
        connect: async (receiver) => broker.connect(owner, receiver),
        disconnect: () => broker.disconnect(owner),
      },
      threadId: 0,
      isMainThread: true,
      env: { HOME: "/home/test" },
      argv: ["node", "main.js"],
      execArgv: [],
      allocateThreadId: () => nextThreadId++,
      output: async () => undefined,
    };
    const threads = createNodeWorkerThreads({ supervisor, moduleLoader, context });
    const failure = Object.assign(new Error("caught unsupported schema"), {
      code: "AJV_SCHEMA_NOT_PRECOMPILED",
    });
    const releaseReady = Promise.withResolvers<void>();

    const process = launchNodeHarnessProcess({
      ...f.input,
      computer: f.input.computer,
      nativeModules: { ...f.input.nativeModules, worker_threads: threads.module },
      loadRelease: async () => ({
        launch() {
          releaseReady.resolve();
        },
        assertRuntimeCompatibility: () => threads.module.assertRuntimeCompatibility(),
      }),
    });
    try {
      await releaseReady.promise;
      threads.module.reportRuntimeFailure(failure);
      await expect(process.assertCompatibility()).rejects.toMatchObject({
        code: "AJV_SCHEMA_NOT_PRECOMPILED",
        message: "caught unsupported schema",
      });
      await expect(process.dispose()).rejects.toMatchObject({
        code: "AJV_SCHEMA_NOT_PRECOMPILED",
      });
    } finally {
      await threads.dispose();
      await f.close();
    }
  });
});
