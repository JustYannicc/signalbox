import { describe, expect, it } from "vite-plus/test";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import type { KernelProgramAdmissionDecision } from "./KernelProgramAdmission.ts";
import {
  asyncBinding,
  createAdmissionKernel,
  exitStatus,
  readFile,
  seedFile,
  text,
} from "./tests/kernelProgramAdmissionFixture.ts";

const redirect = {
  kind: "open" as const,
  fd: 1,
  sourceFd: 0,
  flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
  mode: 0o600,
  path: "out",
};

describe("captured spawn cwd", () => {
  it.each([
    { label: "omitted cwd", cwd: undefined, actions: [redirect], expectedCwd: "/work" },
    {
      label: "relative cwd",
      cwd: "nested",
      actions: [redirect],
      expectedCwd: "/work/nested",
    },
    {
      label: "ordered relative actions",
      cwd: undefined,
      actions: [
        { kind: "chdir" as const, fd: 0, sourceFd: 0, flags: 0, mode: 0, path: "nested" },
        redirect,
      ],
      expectedCwd: "/work/nested",
    },
  ])("resumes $label from its admitted base after the parent changes cwd", async (testCase) => {
    const admitted = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<KernelProgramAdmissionDecision>();
    let actualCwd: string | undefined;
    const kernel = createAdmissionKernel(
      new Map([
        [
          "/bin/tool",
          asyncBinding("tool", async (context) => {
            actualCwd = context.filesystem.cwd;
            context.filesystem.write(1, text("child output"), null);
            return exitStatus(0);
          }),
        ],
      ]),
      {
        admit: () => {
          admitted.resolve();
          return decision.promise;
        },
      },
    );
    const parent = await kernel.startParent();
    try {
      kernel.filesystem.mkdir("/work/nested");
      kernel.filesystem.mkdir("/elsewhere/nested");
      seedFile(kernel.filesystem, "/work/out", "original");
      seedFile(kernel.filesystem, "/work/nested/out", "original");
      seedFile(kernel.filesystem, "/elsewhere/out", "leave alone");
      seedFile(kernel.filesystem, "/elsewhere/nested/out", "leave alone");
      kernel.filesystem.chdir("/work");
      const request: AgentOsSpawnRequest = {
        execPath: "/bin/tool",
        argv: ["tool"],
        env: {},
        ...(testCase.cwd === undefined ? {} : { cwd: testCase.cwd }),
        actions: testCase.actions,
        attributes: {
          flags: 0,
          defaultMask: { low: 0, high: 0 },
          signalMask: { low: 0, high: 0 },
          processGroup: 0,
        },
        pidPointer: 0,
      };
      const pending = kernel.host.spawn(
        {
          filesystem: kernel.filesystem,
          parent: parent.handle,
          signal: new AbortController().signal,
        },
        request,
      );
      await admitted.promise;
      kernel.filesystem.chdir("/elsewhere");
      expect(readFile(kernel.filesystem, `${testCase.expectedCwd}/out`)).toBe("original");
      decision.resolve({ kind: "local" });
      const spawned = await pending;
      if (spawned.status !== "ok") throw new Error("Could not resume admitted spawn");
      await expect(kernel.host.exitStatus(spawned.value)).resolves.toMatchObject({
        status: "ok",
        value: exitStatus(0),
      });
      expect(actualCwd).toBe(testCase.expectedCwd);
      expect(readFile(kernel.filesystem, `${testCase.expectedCwd}/out`)).toBe("child output");
      expect(readFile(kernel.filesystem, "/elsewhere/out")).toBe("leave alone");
      expect(readFile(kernel.filesystem, "/elsewhere/nested/out")).toBe("leave alone");
      expect(kernel.filesystem.cwd).toBe("/elsewhere");
    } finally {
      decision.resolve({ kind: "local" });
      parent.finish();
      await kernel.close();
    }
  });
});
