import { RunnerCommandConfigJson } from "@signalbox/runner-protocol/RunnerCommandProtocol";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { proofProvider, type ProofProviderSdkPort, WORKSPACE_RECEIPT } from "./Provider.ts";
import type {
  ProofCommandReporter,
  ProofCommandStage,
  SourcePreparationDiagnostic,
  SourcePreparationOutcome,
} from "./SourcePreparation.ts";

interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
type ExecAction = () => Promise<ExecResult>;
interface CommandReport {
  readonly step: ProofCommandStage;
  readonly outcome: SourcePreparationOutcome;
  readonly diagnostics?: readonly SourcePreparationDiagnostic[];
}

function controlledSdk(input: {
  readonly exec: readonly ExecAction[];
  readonly upload?: (byteLength: number) => Promise<number>;
}) {
  const calls: Array<"get" | "exec" | "upload" | "download"> = [];
  let nextExec = 0;
  const client = {
    machines: {
      get: async (id: string) => {
        calls.push("get");
        return {
          id,
          imageRef: "test-image",
          resources: { vcpu: 1, memoryBytes: 1, diskBytes: 1 },
          source: null,
        };
      },
      exec: async () => {
        calls.push("exec");
        const action = input.exec[nextExec++];
        if (action === undefined) throw new Error("Unexpected setup command");
        return action();
      },
      files: {
        upload: async (_id, _path, bytes) => {
          calls.push("upload");
          return input.upload === undefined ? bytes.byteLength : input.upload(bytes.byteLength);
        },
        download: async () => {
          calls.push("download");
          throw new Error("Unexpected download");
        },
      },
    },
  } satisfies ProofProviderSdkPort;
  return { client, calls };
}

function reports(overrides?: ProofCommandReporter) {
  const values: CommandReport[] = [];
  const reporter: ProofCommandReporter = async (step, outcome, diagnostics) => {
    values.push({
      step,
      outcome,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });
    await overrides?.(step, outcome, diagnostics);
  };
  return { values, reporter };
}

function commandConfig() {
  return RunnerCommandConfigJson.decode(
    RunnerCommandConfigJson.encode({
      version: 1,
      endpoint: "wss://proof.invalid/api/computer/runner",
      threadId: ThreadId.make("proof-thread"),
      operationId: "proof-owner-command-1",
      machineId: "proof-machine-1",
      generation: 1,
      token: "secret-runner-token",
      workspaceReceipt: WORKSPACE_RECEIPT,
      cgroupPath: "/sys/fs/cgroup/signalbox-command/proof-owner-command-1-g1",
    }),
  );
}

const success = (): Promise<ExecResult> => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });

describe("Boxd proof command diagnostics", () => {
  it("classifies a workspace native exec failure without exposing output or running later phases", async () => {
    const sdk = controlledSdk({
      exec: [
        () =>
          Promise.resolve({
            exitCode: 1,
            stdout: "secret-workspace-stdout",
            stderr: "OSError: [Errno 18] Invalid cross-device link: '/secret/path'",
          }),
      ],
    });
    const recorded = reports();
    const provider = proofProvider(sdk.client, "proof-owner", recorded.reporter);

    await expect(
      provider.vm.exec(
        "proof-machine-1",
        ["-c", "# BOXD_PROOF:prepare\nraise RuntimeError('private')"],
        "/",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Proof provider setup or closure failed");

    expect(sdk.calls).toEqual(["exec"]);
    expect(recorded.values).toEqual([
      { step: "workspaceNativePrepare", outcome: "pending" },
      {
        step: "workspaceNativePrepare",
        outcome: "failed",
        diagnostics: [
          { kind: "errorName", value: "Error" },
          { kind: "exitCode", value: 1 },
          { kind: "osErrno", value: 18 },
          { kind: "stderrCategory", value: "OSError" },
          { kind: "stderrCategory", value: "cross-device" },
        ],
      },
    ]);
    expect(JSON.stringify(recorded.values)).not.toContain("secret-");
    expect(JSON.stringify(recorded.values)).not.toContain("/secret/path");
  });

  it("identifies the fixed nonempty-workspace gate without recording its stderr", async () => {
    const sdk = controlledSdk({
      exec: [
        () =>
          Promise.resolve({
            exitCode: 1,
            stdout: "private command output",
            stderr:
              "RuntimeError: proof workspace must be empty before hydration\nprivate stderr detail",
          }),
      ],
    });
    const recorded = reports();
    const provider = proofProvider(sdk.client, "proof-owner", recorded.reporter);
    await expect(
      provider.vm.exec(
        "proof-machine-1",
        ["-c", "# BOXD_PROOF:prepare"],
        "/",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Proof provider setup or closure failed");
    expect(recorded.values.at(-1)).toEqual({
      step: "workspaceNativePrepare",
      outcome: "failed",
      diagnostics: [
        { kind: "errorName", value: "Error" },
        { kind: "exitCode", value: 1 },
        { kind: "stderrCategory", value: "workspace-not-empty" },
      ],
    });
    expect(JSON.stringify(recorded.values)).not.toContain("private");
  });

  it("keeps the remaining native workspace script labels fixed", async () => {
    const stages = [
      ["# BOXD_PROOF:finalize", "workspaceNativeFinalize"],
      ["# BOXD_PROOF:scan", "workspaceNativeScan"],
      ["# BOXD_PROOF:canonical-cwd", "workspaceNativeCwd"],
    ] as const;

    for (const [prefix, step] of stages) {
      const sdk = controlledSdk({
        exec: [
          () =>
            Promise.resolve({
              exitCode: 2,
              stdout: "private",
              stderr: "PermissionError: private detail",
            }),
        ],
      });
      const recorded = reports();
      const provider = proofProvider(sdk.client, "proof-owner", recorded.reporter);

      await expect(
        provider.vm.exec(
          "proof-machine-1",
          ["-c", `${prefix}\nraise RuntimeError('private')`],
          "/workspace",
          new AbortController().signal,
        ),
      ).rejects.toThrow("Proof provider setup or closure failed");

      expect(sdk.calls).toEqual(["exec"]);
      expect(recorded.values).toEqual([
        { step, outcome: "pending" },
        {
          step,
          outcome: "failed",
          diagnostics: [
            { kind: "errorName", value: "Error" },
            { kind: "exitCode", value: 2 },
            { kind: "stderrCategory", value: "PermissionError" },
          ],
        },
      ]);
      expect(JSON.stringify(recorded.values)).not.toContain("private");
    }
  });

  it("records the exact Runner setup failure and preserves the SDK error when reporting fails", async () => {
    const sdkError = Object.assign(new Error("secret token and endpoint"), {
      name: "AuthenticationError",
      grpcCode: 7,
      status: 403,
    });
    const sdk = controlledSdk({
      exec: [() => Promise.resolve({ exitCode: 0, stdout: "proof-owner", stderr: "" })],
      upload: () => Promise.reject(sdkError),
    });
    const recorded = reports(async (step, outcome) => {
      if (step === "runnerConfigUpload" && outcome === "failed") {
        throw new Error("report store unavailable");
      }
    });
    const provider = proofProvider(sdk.client, "proof-owner", recorded.reporter);

    await expect(provider.launch(commandConfig(), new AbortController().signal)).rejects.toBe(
      sdkError,
    );

    expect(sdk.calls).toEqual(["exec", "upload"]);
    expect(recorded.values).toEqual([
      { step: "inheritedSourceCheck", outcome: "pending" },
      { step: "inheritedSourceCheck", outcome: "passed" },
      { step: "runnerConfigUpload", outcome: "pending" },
      {
        step: "runnerConfigUpload",
        outcome: "failed",
        diagnostics: [
          { kind: "errorName", value: "AuthenticationError" },
          { kind: "grpcCode", value: 7 },
          { kind: "status", value: 403 },
        ],
      },
    ]);
    expect(JSON.stringify(recorded.values)).not.toContain("secret");
    expect(JSON.stringify(recorded.values)).not.toContain("endpoint");
  });

  it("records Runner connection setup phases in order", async () => {
    const sdk = controlledSdk({
      exec: [
        () => Promise.resolve({ exitCode: 0, stdout: "proof-owner", stderr: "" }),
        success,
        () =>
          Promise.resolve({ exitCode: 0, stdout: '{"launched":true,"joined":true}', stderr: "" }),
      ],
    });
    const recorded = reports();
    const provider = proofProvider(sdk.client, "proof-owner", recorded.reporter);

    await expect(
      provider.launch(commandConfig(), new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(sdk.calls).toEqual(["exec", "upload", "upload", "exec", "exec"]);
    expect(recorded.values.map(({ step, outcome }) => [step, outcome])).toEqual([
      ["inheritedSourceCheck", "pending"],
      ["inheritedSourceCheck", "passed"],
      ["runnerConfigUpload", "pending"],
      ["runnerConfigUpload", "passed"],
      ["runnerReceiptUpload", "pending"],
      ["runnerReceiptUpload", "passed"],
      ["runnerBootstrapInstall", "pending"],
      ["runnerBootstrapInstall", "passed"],
      ["runnerLaunchFence", "pending"],
      ["runnerLaunchFence", "passed"],
    ]);
  });
});
