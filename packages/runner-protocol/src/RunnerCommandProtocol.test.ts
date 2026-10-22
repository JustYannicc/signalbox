import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";

import { RunnerCommandConfigJson } from "./RunnerCommandProtocol.ts";

const threadId = ThreadId.make("command-thread-1");
const config = {
  version: 1 as const,
  endpoint: "wss://cloud.example/api/computer/runner",
  threadId,
  operationId: "operation-1",
  machineId: "machine-1",
  generation: 3,
  token: "launch-secret",
  workspaceReceipt: "/run/signalbox-command/workspace.json",
};

describe("command Runner config", () => {
  it("carries a resolved host identity while accepting legacy configs without one", () => {
    const systemIdentity = systemIdentityForThread(threadId);
    const withIdentity = { ...config, systemIdentity };

    expect(RunnerCommandConfigJson.decode(RunnerCommandConfigJson.encode(withIdentity))).toEqual(
      withIdentity,
    );
    expect(RunnerCommandConfigJson.decode(RunnerCommandConfigJson.encode(config))).toEqual(config);
  });

  it("rejects malformed host identity metadata", () => {
    expect(() =>
      RunnerCommandConfigJson.decode(
        JSON.stringify({
          ...config,
          systemIdentity: { ...systemIdentityForThread(threadId), hostname: "not a hostname" },
        }),
      ),
    ).toThrow();
  });
});
