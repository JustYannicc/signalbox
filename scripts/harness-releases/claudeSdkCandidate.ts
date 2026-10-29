import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const SDK_PROVIDER = "claude-agent-sdk";

function failureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,100}$/u.test(message) ? message : "CLAUDE_SDK_BUILD_FAILED";
}

function isStableVersion(value: string | undefined): value is string {
  return value !== undefined && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value);
}

export interface ClaudeSdkFailureEvidence {
  readonly workspace?: string;
  readonly stage: string;
  readonly releaseIdentity?: unknown;
  readonly dependencyGraph?: unknown;
  readonly sourceFreeze?: unknown;
}

function textField(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Reflect.get(value, key);
  if (typeof field === "string") return field;
  if (field instanceof Uint8Array) return Buffer.from(field).toString("utf8");
  return undefined;
}

function causeValue(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, "cause");
}

function nestedOutput(error: unknown, key: "stderr" | "stdout") {
  const seen = new Set<unknown>();
  let current = error;
  let result: string | undefined;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    result = textField(current, key) ?? result;
    current = causeValue(current);
  }
  return result;
}

function nestedErrorLog(error: unknown) {
  const seen = new Set<unknown>();
  const entries: string[] = [];
  let current = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) entries.push(current.stack ?? current.message);
    else entries.push(String(current));
    const errors =
      typeof current === "object" && current !== null ? Reflect.get(current, "errors") : undefined;
    if (Array.isArray(errors))
      for (const item of errors)
        entries.push(item instanceof Error ? (item.stack ?? item.message) : String(item));
    current = causeValue(current);
  }
  return entries.join("\n\n--- cause ---\n\n");
}

export async function pathExists(path: string) {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Keep every rejected candidate and its safe, path-free reason beside the requested output. */
export async function preserveRejectedClaudeSdkCandidate(
  candidate: string,
  output: string,
  version: string | undefined,
  error: unknown,
  evidence?: ClaudeSdkFailureEvidence,
) {
  const token = NodeCrypto.randomUUID();
  const rejected = `${output}.rejected-${token}`;
  const report = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "rejected",
        provider: SDK_PROVIDER,
        version: isStableVersion(version) ? version : null,
        failureCode: failureCode(error),
      },
      null,
      2,
    )}\n`,
  );
  await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
  try {
    const stat = await NodeFSP.lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error("CLAUDE_SDK_REJECTED_CANDIDATE_SYMLINK");
    await NodeFSP.rename(candidate, rejected);
  } catch (candidateError) {
    if (
      !(
        candidateError instanceof Error &&
        "code" in candidateError &&
        candidateError.code === "ENOENT"
      )
    )
      throw candidateError;
    await NodeFSP.mkdir(rejected, { recursive: false });
  }
  await NodeFSP.writeFile(NodePath.join(rejected, "failure.json"), report, { flag: "wx" });
  if (evidence) {
    const diagnostics = NodePath.join(rejected, "diagnostics");
    await NodeFSP.mkdir(diagnostics, { recursive: true });
    const details = {
      schemaVersion: 1,
      stage: evidence.stage,
      releaseIdentity: evidence.releaseIdentity ?? null,
      dependencyGraph: evidence.dependencyGraph ?? null,
      sourceFreeze: evidence.sourceFreeze ?? null,
      retainedWorkspace: evidence.workspace ? "build-workspace" : null,
    };
    await NodeFSP.writeFile(
      NodePath.join(diagnostics, "build-context.json"),
      `${JSON.stringify(details, null, 2)}\n`,
      { flag: "wx" },
    );
    const stderr = nestedOutput(error, "stderr");
    const stdout = nestedOutput(error, "stdout");
    if (stderr)
      await NodeFSP.writeFile(NodePath.join(diagnostics, "stderr.log"), stderr, { flag: "wx" });
    if (stdout)
      await NodeFSP.writeFile(NodePath.join(diagnostics, "stdout.log"), stdout, { flag: "wx" });
    const errorLog = nestedErrorLog(error);
    if (errorLog)
      await NodeFSP.writeFile(NodePath.join(diagnostics, "error.log"), errorLog, { flag: "wx" });
    if (evidence.workspace) {
      const workspace = await NodeFSP.realpath(evidence.workspace);
      await NodeFSP.cp(workspace, NodePath.join(rejected, "build-workspace"), {
        recursive: true,
        filter: (path) => {
          const relative = NodePath.relative(workspace, path);
          return relative === "" || relative.split(NodePath.sep)[0] !== "cache";
        },
      });
    }
  }
  return rejected;
}
