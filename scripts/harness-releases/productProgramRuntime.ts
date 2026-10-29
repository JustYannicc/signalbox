import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function runBuild(
  command: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
): Promise<void> {
  const log = await NodeFSP.open(logPath, "wx", 0o600);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = NodeChildProcess.spawn(command, [...args], {
        cwd,
        env: safeBuildEnvironment(),
        stdio: ["ignore", log.fd, log.fd],
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (exit !== 0)
      throw new Error(
        `PRODUCT_PROGRAM_BUILD_FAILED:${NodePath.basename(command)}:exit=${String(exit)}`,
      );
  } finally {
    await log.close();
  }
}

export async function writeOnce(path: string, bytes: Uint8Array): Promise<void> {
  await NodeFSP.writeFile(path, bytes, { flag: "wx", mode: 0o444 });
}

export async function writeJsonOnce(path: string, value: unknown): Promise<void> {
  await writeOnce(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

export async function preserveProgramInputFailure(directory: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  const failureCode = /^PRODUCT_PROGRAM_[A-Z0-9_:.-]+$/u.test(message)
    ? message
    : "PRODUCT_PROGRAM_INPUTS_FAILED";
  try {
    await writeJsonOnce(NodePath.join(directory, "failure.json"), {
      schemaVersion: 1,
      status: "rejected",
      failureCode,
    });
  } catch (preservationError) {
    throw new AggregateError(
      [cause, preservationError],
      "PRODUCT_PROGRAM_FAILURE_EVIDENCE_WRITE_FAILED",
      { cause: preservationError },
    );
  }
}

export function safeBuildEnvironment(): NodeJS.ProcessEnv {
  const names = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"] as const;
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}
