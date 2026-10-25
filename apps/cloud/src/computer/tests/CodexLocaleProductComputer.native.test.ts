import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelCommand } from "../../kernel/KernelCommandForwarder.ts";
import {
  CODEX_UNIFIED_EXEC_ENV,
  createCodexLocaleProductComputer,
  loadCodexLocalePrograms,
} from "./CodexLocaleProductComputerFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const programs = loadCodexLocalePrograms();

async function run(
  fixture: ReturnType<typeof createCodexLocaleProductComputer>,
  executable: string,
  argv: readonly string[],
) {
  const child = await fixture.computer.exec(
    { executable, argv: [...argv], cwd: "/workspace", env: { ...CODEX_UNIFIED_EXEC_ENV } },
    new AbortController().signal,
    undefined,
  );
  let disposeError: string | undefined;
  let result:
    | {
        readonly stdout: string;
        readonly stderr: string;
        readonly exitCode: number | null;
        readonly error: string | undefined;
      }
    | undefined;
  try {
    const writer = child.stdin.getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    const [stdout, stderr, exit] = await Promise.allSettled([
      readText(child.stdout),
      readText(child.stderr),
      child.exited,
    ]);
    result = {
      stdout: stdout.status === "fulfilled" ? stdout.value : "",
      stderr: stderr.status === "fulfilled" ? stderr.value : "",
      exitCode: exit.status === "fulfilled" ? exit.value.exitCode : null,
      error: exit.status === "rejected" ? String(exit.reason) : undefined,
    };
  } finally {
    try {
      await child.dispose();
    } catch (error) {
      disposeError = String(error);
    }
  }
  if (result === undefined) throw new Error("Computer command did not produce an observation");
  return { ...result, disposeError };
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

describe.skipIf(programs === undefined)(
  "public ProductComputer under Codex's forced locale",
  () => {
    it("runs bare sed -i locally with the exact official ten-variable environment", async () => {
      if (programs === undefined) throw new Error("Pinned Codex locale programs are unavailable");
      const fixture = createCodexLocaleProductComputer(programs);
      let observation: Record<string, unknown> | undefined;
      let cleanupError: string | undefined;
      try {
        const gitInit = await run(fixture, "/usr/bin/git", [
          "/usr/bin/git",
          "init",
          "--initial-branch=main",
          ".",
        ]);
        const gitAdd = await run(fixture, "/usr/bin/git", ["/usr/bin/git", "add", "proof.txt"]);
        const gitCommit = await run(fixture, "/usr/bin/git", [
          "/usr/bin/git",
          "-c",
          "user.name=Codex fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "Seed isolated worktree",
        ]);

        const shell = await run(fixture, "/bin/bash", [
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          "sed -i 's/BEFORE/AFTER/' proof.txt",
        ]);
        const status = await run(fixture, "/usr/bin/git", ["/usr/bin/git", "status", "--short"]);
        const shellCommand = fixture.loaderCommands.find(
          (command) => command.executable === "/bin/bash",
        );
        const sedCommand = fixture.loaderCommands.find(
          (command) => command.executable === "/bin/sed" || command.executable === "sed",
        );
        const sedResult = fixture.loaderGuestResults.find(
          (result) => result.executable === "/bin/sed",
        );
        observation = {
          officialEnvironment: CODEX_UNIFIED_EXEC_ENV,
          officialEnvironmentKeys: Object.keys(CODEX_UNIFIED_EXEC_ENV).sort(),
          shellEnvironment: shellCommand?.env,
          pathInOfficialEnvironment: Object.hasOwn(CODEX_UNIFIED_EXEC_ENV, "PATH"),
          setupExitCodes: [gitInit.exitCode, gitAdd.exitCode, gitCommit.exitCode],
          sedCommand: sedCommand
            ? {
                executable: sedCommand.executable,
                argv: sedCommand.argv,
                env: sedCommand.env,
              }
            : undefined,
          pathInSedEnvironment:
            sedCommand === undefined ? undefined : Object.hasOwn(sedCommand.env, "PATH"),
          gnuSedGuestDispatched: fixture.loaderGuestPrograms.includes("sed"),
          sedExitCode: sedResult?.exitCode,
          shellExitCode: shell.exitCode,
          shellError: shell.error,
          canonicalBytes: [...fixture.readFile("/workspace/proof.txt")],
          gitStatusExitCode: status.exitCode,
          gitStatus: status.stdout,
          machineAdmissions: fixture.machineCalls.map((command: KernelCommand) => ({
            executable: command.executable,
            argv: command.argv,
            cwd: command.cwd,
            env: command.env,
          })),
        };
      } finally {
        try {
          await fixture.close();
        } catch (error) {
          cleanupError = String(error);
        }
      }

      expect({ observation, cleanupError }).toEqual({
        observation: {
          officialEnvironment: {
            NO_COLOR: "1",
            TERM: "dumb",
            LANG: "C.UTF-8",
            LC_CTYPE: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            COLORTERM: "",
            PAGER: "cat",
            GIT_PAGER: "cat",
            GH_PAGER: "cat",
            CODEX_CI: "1",
          },
          officialEnvironmentKeys: [
            "CODEX_CI",
            "COLORTERM",
            "GH_PAGER",
            "GIT_PAGER",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "NO_COLOR",
            "PAGER",
            "TERM",
          ],
          shellEnvironment: CODEX_UNIFIED_EXEC_ENV,
          pathInOfficialEnvironment: false,
          setupExitCodes: [0, 0, 0],
          sedCommand: {
            executable: "/bin/sed",
            argv: ["sed", "-i", "s/BEFORE/AFTER/", "proof.txt"],
            env: expect.objectContaining(CODEX_UNIFIED_EXEC_ENV),
          },
          pathInSedEnvironment: false,
          gnuSedGuestDispatched: true,
          sedExitCode: 0,
          shellExitCode: 0,
          shellError: undefined,
          canonicalBytes: [...new TextEncoder().encode("AFTER\n")],
          gitStatusExitCode: 0,
          gitStatus: " M proof.txt\n",
          machineAdmissions: [],
        },
        cleanupError: undefined,
      });
    });
  },
);
