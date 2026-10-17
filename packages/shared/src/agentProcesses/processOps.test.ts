import { expect, it } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { createNodeProcessOps, sameIdentity } from "@t3tools/shared/agentProcessInspection";
import type { ProcessIdentity } from "@t3tools/shared/agentProcesses";

const preciseStart: ProcessIdentity = {
  platform: "darwin",
  bootId: "boot-1",
  startTime: "1792225084:431936",
};

it("distinguishes macOS process starts within the same second", () => {
  const nextProcess = { ...preciseStart, startTime: "1792225084:431937" };

  expect(sameIdentity(preciseStart, nextProcess)).toBe(false);
});

it.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
  "reads microsecond macOS process start time",
  async () => {
    const identity = await createNodeProcessOps().identify(process.pid);

    expect(identity?.platform).toBe("darwin");
    expect(identity?.startTime).toMatch(/^\d+:\d{6}$/);
  },
);
