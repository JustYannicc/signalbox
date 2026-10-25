export type SourcePreparationStep = "directoriesExec" | "runnerUpload" | "installExec";
export type SourcePreparationOutcome = "pending" | "passed" | "failed";
export type ProofCommandStage =
  | "workspacePrepare"
  | "runtimeConnect"
  | "inheritedSourceCheck"
  | "runnerConfigUpload"
  | "runnerReceiptUpload"
  | "runnerBootstrapInstall"
  | "runnerLaunchFence"
  | "workspaceNativePrepare"
  | "workspaceNativeFinalize"
  | "workspaceNativeScan"
  | "workspaceNativeCwd"
  | "workspaceNativeFileUpload";

const SOURCE_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "BoxdError",
  "BoxdProofWorkspaceError",
  "AuthenticationError",
  "PermissionDeniedError",
  "NotFoundError",
  "ConflictError",
  "RateLimitError",
  "APIStatusError",
  "APIConnectionError",
] as const;
type SourceErrorName = (typeof SOURCE_ERROR_NAMES)[number];

const SOURCE_STDERR_CATEGORIES = [
  {
    value: "workspace-not-empty",
    pattern: /(?:^|\n)RuntimeError: proof workspace must be empty before hydration(?:\n|$)/,
  },
  { value: "OSError", pattern: /(?:^|\n)OSError(?::|\s)/ },
  { value: "cross-device", pattern: /\b(?:invalid cross-device link|EXDEV)\b/i },
  { value: "SyntaxError", pattern: /(?:^|\n)SyntaxError(?::|\s)/ },
  { value: "PermissionError", pattern: /(?:^|\n)PermissionError(?::|\s)/ },
  { value: "FileNotFoundError", pattern: /(?:^|\n)FileNotFoundError(?::|\s)/ },
  { value: "ModuleNotFoundError", pattern: /(?:^|\n)ModuleNotFoundError(?::|\s)/ },
  { value: "sudo", pattern: /(?:^|\n)sudo:\s/ },
  { value: "read-only", pattern: /\b(?:read-only file system|EROFS)\b/i },
  { value: "no-space", pattern: /\b(?:no space left on device|ENOSPC)\b/i },
] as const;
type SourceStderrCategory = (typeof SOURCE_STDERR_CATEGORIES)[number]["value"];

export type SourcePreparationDiagnostic =
  | { readonly kind: "errorName"; readonly value: SourceErrorName }
  | { readonly kind: "grpcCode"; readonly value: number }
  | { readonly kind: "status"; readonly value: number }
  | { readonly kind: "exitCode"; readonly value: number }
  | { readonly kind: "osErrno"; readonly value: number }
  | { readonly kind: "stderrCategory"; readonly value: SourceStderrCategory };

export type SourcePreparationReporter = (
  step: SourcePreparationStep,
  outcome: SourcePreparationOutcome,
  diagnostics?: readonly SourcePreparationDiagnostic[],
) => Promise<void>;
export type ProofCommandReporter = (
  step: ProofCommandStage,
  outcome: SourcePreparationOutcome,
  diagnostics?: readonly SourcePreparationDiagnostic[],
) => Promise<void>;

function numericProperty(
  error: unknown,
  name: "grpcCode" | "status",
  minimum: number,
  maximum: number,
) {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const value = Reflect.get(error, name);
    return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

class SourcePreparationCommandFailure extends Error {
  readonly exitCode: number;
  readonly osErrno: number | undefined;
  readonly stderrCategories: readonly SourceStderrCategory[];

  constructor(exitCode: number, stderr: string) {
    super("Proof provider setup or closure failed");
    this.exitCode = exitCode;
    const match =
      /(?:OSError|PermissionError|FileNotFoundError|FileExistsError|NotADirectoryError|IsADirectoryError): \[Errno (\d{1,3})\]/.exec(
        stderr,
      );
    const errno = match === null ? undefined : Number(match[1]);
    this.osErrno = errno !== undefined && errno >= 1 && errno <= 133 ? errno : undefined;
    this.stderrCategories = SOURCE_STDERR_CATEGORIES.filter(({ pattern }) =>
      pattern.test(stderr),
    ).map(({ value }) => value);
  }
}

export function sourcePreparationCommandFailure(exitCode: number, stderr: string) {
  return new SourcePreparationCommandFailure(exitCode, stderr);
}

function sourceFailureDiagnostics(error: unknown): readonly SourcePreparationDiagnostic[] {
  const diagnostics: SourcePreparationDiagnostic[] = [];
  if (error instanceof Error) {
    const name = SOURCE_ERROR_NAMES.find((candidate) => candidate === error.name);
    if (name !== undefined) diagnostics.push({ kind: "errorName", value: name });
  }
  const grpcCode = numericProperty(error, "grpcCode", 0, 16);
  if (grpcCode !== undefined) diagnostics.push({ kind: "grpcCode", value: grpcCode });
  const status = numericProperty(error, "status", 100, 599);
  if (status !== undefined) diagnostics.push({ kind: "status", value: status });
  if (error instanceof SourcePreparationCommandFailure) {
    if (Number.isSafeInteger(error.exitCode) && error.exitCode >= 1 && error.exitCode <= 255) {
      diagnostics.push({ kind: "exitCode", value: error.exitCode });
    }
    if (error.osErrno !== undefined) diagnostics.push({ kind: "osErrno", value: error.osErrno });
    for (const value of error.stderrCategories) diagnostics.push({ kind: "stderrCategory", value });
  }
  return diagnostics;
}

export async function runSourceStep<A>(
  reporter: SourcePreparationReporter | undefined,
  step: SourcePreparationStep,
  action: () => Promise<A>,
): Promise<A> {
  await reporter?.(step, "pending");
  let result: A;
  try {
    result = await action();
  } catch (error) {
    if (reporter !== undefined) {
      try {
        await reporter(step, "failed", sourceFailureDiagnostics(error));
      } catch {
        // Preserve the provider or command rejection that failed this step.
      }
    }
    throw error;
  }
  await reporter?.(step, "passed");
  return result;
}

/** Keeps phase persistence required while preserving a provider error if its failure report fails. */
export async function runProofCommandStage<A>(
  reporter: ProofCommandReporter | undefined,
  step: ProofCommandStage,
  action: () => Promise<A>,
): Promise<A> {
  if (reporter === undefined) return action();
  await reporter(step, "pending");
  let result: A;
  try {
    result = await action();
  } catch (error) {
    try {
      await reporter(step, "failed", sourceFailureDiagnostics(error));
    } catch {
      // Keep the provider or workspace rejection as the failure reported to the worker.
    }
    throw error;
  }
  await reporter(step, "passed");
  return result;
}
