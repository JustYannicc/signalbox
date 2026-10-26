import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { ComputerExecPort } from "./Computer.ts";

async function hasRepository(files: KernelFileSystem, signal: AbortSignal) {
  let directory = files.cwd;
  for (;;) {
    signal.throwIfAborted();
    try {
      await files.lstatAsync(`${directory === "/" ? "" : directory}/.git`, signal);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (directory === "/") return false;
    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
  }
}

async function discard(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    for (;;) {
      if ((await reader.read()).done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

async function closeInput(stream: WritableStream<Uint8Array>) {
  const writer = stream.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

/** Runs with hydration quiescent, before the native runtime can edit canonical files. */
export async function prepareHydratedRepository(input: {
  readonly files: KernelFileSystem;
  readonly commands: ComputerExecPort;
  readonly signal: AbortSignal;
}) {
  const { files, commands, signal } = input;
  if (!(await hasRepository(files, signal))) return { status: "not-a-repository" } as const;
  signal.throwIfAborted();
  const child = await commands.exec(
    {
      executable: "/usr/bin/git",
      argv: ["/usr/bin/git", "update-index", "--refresh"],
      cwd: files.cwd,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C",
      },
    },
    // Caller cancellation is checked after Git releases its own index lock.
    new AbortController().signal,
    undefined,
  );
  const io = [closeInput(child.stdin), discard(child.stdout), discard(child.stderr)];
  try {
    const [, exit] = await Promise.all([Promise.all(io), child.exited]);
    signal.throwIfAborted();
    if (exit.signal !== 0 || exit.coreDumped || (exit.exitCode !== 0 && exit.exitCode !== 1))
      throw new Error("Hydrated repository index refresh failed", { cause: exit });
    // Git leaves changed/unmerged entries alone and returns 1 while refreshing clean entries.
    return exit.exitCode === 0
      ? ({ status: "ready" } as const)
      : ({ status: "needs-update" } as const);
  } finally {
    try {
      await child.dispose();
    } finally {
      await Promise.allSettled(io);
    }
  }
}
