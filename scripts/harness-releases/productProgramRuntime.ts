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
    const stderr = await NodeFSP.open(`${logPath}.stderr`, "wx+", 0o600);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = NodeChildProcess.spawn(command, [...args], {
          cwd,
          env: safeBuildEnvironment(),
          stdio: ["ignore", log.fd, stderr.fd],
        });
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (exit !== 0)
        throw new Error(
          `PRODUCT_PROGRAM_BUILD_FAILED:${NodePath.basename(command)}:exit=${String(exit)}`,
        );
    } catch (cause) {
      const size = (await stderr.stat()).size;
      const tail = Buffer.alloc(Math.min(size, 16 * 1024));
      await stderr.read(tail, 0, tail.length, size - tail.length);
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = message.startsWith("PRODUCT_PROGRAM_BUILD_FAILED:")
        ? message
        : `PRODUCT_PROGRAM_BUILD_FAILED:${NodePath.basename(command)}:spawn`;
      throw new Error(
        `${code}\n${message === code ? "" : `${message}\n`}Build stderr tail:\n${tail.toString("utf8") || "(no child output)"}`,
        { cause },
      );
    } finally {
      await stderr.close();
    }
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
  const message = cause instanceof Error ? cause.message.split("\n")[0]! : "";
  const failureCode = /^PRODUCT_PROGRAM_[A-Za-z0-9_:=.-]+$/u.test(message)
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
