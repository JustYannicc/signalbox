import { describe, expect, it } from "vite-plus/test";
import { proofProvider, type ProofProviderSdkPort } from "./Provider.ts";
import type {
  SourcePreparationDiagnostic,
  SourcePreparationOutcome,
  SourcePreparationReporter,
  SourcePreparationStep,
} from "./SourcePreparation.ts";

interface SourceReport {
  readonly step: SourcePreparationStep;
  readonly outcome: SourcePreparationOutcome;
  readonly diagnostics?: readonly SourcePreparationDiagnostic[];
}
type SourceReporter = SourcePreparationReporter;
interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
type ExecAction = () => Promise<ExecResult>;

function controlledSdk(input: {
  readonly exec: readonly ExecAction[];
  readonly upload?: () => Promise<number>;
}) {
  const calls: Array<"exec" | "upload" | "download"> = [];
  let nextExec = 0;
  const client = {
    machines: {
      exec: async () => {
        calls.push("exec");
        const action = input.exec[nextExec++];
        if (action === undefined) throw new Error("Unexpected setup command");
        return action();
      },
      files: {
        upload: async () => {
          calls.push("upload");
          return input.upload === undefined ? 0 : input.upload();
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

function reports() {
  const values: SourceReport[] = [];
  const reporter: SourceReporter = async (step, outcome, diagnostics) => {
    values.push({
      step,
      outcome,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });
  };
  return { values, reporter };
}

function prepareSource(
  client: ReturnType<typeof controlledSdk>["client"],
  reporter: SourceReporter,
) {
  const provider = proofProvider(client, "proof-owner");
  return provider.prepareSource(
    "source-id",
    new Uint8Array([1, 2, 3]),
    new AbortController().signal,
    reporter,
  );
}

const success = (): Promise<ExecResult> => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });

describe("Boxd proof source preparation", () => {
  it("records a first-command failure and stops before upload", async () => {
    const sdk = controlledSdk({
      exec: [
        () =>
          Promise.resolve({
            exitCode: 7,
            stdout: "secret-output-must-not-escape",
            stderr: "PermissionError: blocked secret-stderr-must-not-escape",
          }),
      ],
    });
    const recorded = reports();

    await expect(prepareSource(sdk.client, recorded.reporter)).rejects.toThrow(
      "Proof provider setup or closure failed",
    );

    expect(sdk.calls).toEqual(["exec"]);
    expect(recorded.values).toEqual([
      { step: "directoriesExec", outcome: "pending" },
      {
        step: "directoriesExec",
        outcome: "failed",
        diagnostics: [
          { kind: "errorName", value: "Error" },
          { kind: "exitCode", value: 7 },
          { kind: "stderrCategory", value: "PermissionError" },
        ],
      },
    ]);
    expect(JSON.stringify(recorded.values)).not.toContain("secret-");
  });

  it("records an upload SDK rejection without exposing its message or starting install", async () => {
    const sdkError = Object.assign(new Error("api key secret should stay private"), {
      name: "AuthenticationError",
      grpcCode: 7,
      status: 403,
    });
    const sdk = controlledSdk({ exec: [success], upload: () => Promise.reject(sdkError) });
    const recorded = reports();

    await expect(prepareSource(sdk.client, recorded.reporter)).rejects.toBe(sdkError);

    expect(sdk.calls).toEqual(["exec", "upload"]);
    expect(recorded.values).toEqual([
      { step: "directoriesExec", outcome: "pending" },
      { step: "directoriesExec", outcome: "passed" },
      { step: "runnerUpload", outcome: "pending" },
      {
        step: "runnerUpload",
        outcome: "failed",
        diagnostics: [
          { kind: "errorName", value: "AuthenticationError" },
          { kind: "grpcCode", value: 7 },
          { kind: "status", value: 403 },
        ],
      },
    ]);
    expect(JSON.stringify(recorded.values)).not.toContain("api key");
  });

  it("drops unknown error names and invalid numeric properties", async () => {
    const sdkError = Object.assign(new Error("credential secret must stay private"), {
      name: "CredentialSecretError",
      grpcCode: 999,
      status: "secret-status",
    });
    const sdk = controlledSdk({ exec: [success], upload: () => Promise.reject(sdkError) });
    const recorded = reports();

    await expect(prepareSource(sdk.client, recorded.reporter)).rejects.toBe(sdkError);

    expect(recorded.values.at(-1)).toEqual({
      step: "runnerUpload",
      outcome: "failed",
      diagnostics: [],
    });
    expect(JSON.stringify(recorded.values)).not.toContain("CredentialSecretError");
    expect(JSON.stringify(recorded.values)).not.toContain("secret");
  });

  it("separates install failure from the directory and upload passes", async () => {
    const sdk = controlledSdk({
      exec: [
        success,
        () =>
          Promise.resolve({
            exitCode: 2,
            stdout: "",
            stderr: "ModuleNotFoundError: runner dependency unavailable",
          }),
      ],
      upload: () => Promise.resolve(3),
    });
    const recorded = reports();

    await expect(prepareSource(sdk.client, recorded.reporter)).rejects.toThrow(
      "Proof provider setup or closure failed",
    );

    expect(sdk.calls).toEqual(["exec", "upload", "exec"]);
    expect(recorded.values).toEqual([
      { step: "directoriesExec", outcome: "pending" },
      { step: "directoriesExec", outcome: "passed" },
      { step: "runnerUpload", outcome: "pending" },
      { step: "runnerUpload", outcome: "passed" },
      { step: "installExec", outcome: "pending" },
      {
        step: "installExec",
        outcome: "failed",
        diagnostics: [
          { kind: "errorName", value: "Error" },
          { kind: "exitCode", value: 2 },
          { kind: "stderrCategory", value: "ModuleNotFoundError" },
        ],
      },
    ]);
  });

  it("records a bounded OS errno without exposing paths from the failed install", async () => {
    const sdk = controlledSdk({
      exec: [
        success,
        () =>
          Promise.resolve({
            exitCode: 1,
            stdout: "private-output",
            stderr:
              "OSError: [Errno 18] Invalid cross-device link: '/private/source' -> '/private/target'",
          }),
      ],
      upload: () => Promise.resolve(3),
    });
    const recorded = reports();

    await expect(prepareSource(sdk.client, recorded.reporter)).rejects.toThrow(
      "Proof provider setup or closure failed",
    );

    expect(recorded.values.at(-1)).toEqual({
      step: "installExec",
      outcome: "failed",
      diagnostics: [
        { kind: "errorName", value: "Error" },
        { kind: "exitCode", value: 1 },
        { kind: "osErrno", value: 18 },
        { kind: "stderrCategory", value: "OSError" },
        { kind: "stderrCategory", value: "cross-device" },
      ],
    });
    expect(JSON.stringify(recorded.values)).not.toContain("private");
  });

  it("records all three setup phases as passed", async () => {
    const sdk = controlledSdk({ exec: [success, success], upload: () => Promise.resolve(3) });
    const recorded = reports();

    await expect(prepareSource(sdk.client, recorded.reporter)).resolves.toBeUndefined();

    expect(sdk.calls).toEqual(["exec", "upload", "exec"]);
    expect(recorded.values).toEqual([
      { step: "directoriesExec", outcome: "pending" },
      { step: "directoriesExec", outcome: "passed" },
      { step: "runnerUpload", outcome: "pending" },
      { step: "runnerUpload", outcome: "passed" },
      { step: "installExec", outcome: "pending" },
      { step: "installExec", outcome: "passed" },
    ]);
  });
});
