import { describe, expect, it } from "vite-plus/test";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { createHookService } from "../../src/hooks/HookService.ts";
import { KernelCommandExecutor } from "../../src/kernel/KernelCommandExecutor.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { canonicalFileByteSelection } from "../../src/kernel/KernelFileBytes.ts";
import type {
  KernelCommandChild,
  KernelCommandForwarder,
} from "../../src/kernel/KernelCommandForwarder.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import {
  CLAUDE_HOOK_COMMAND_LOG,
  CLAUDE_TOOL_FILE,
  claudeToolScript,
  createClaudeHookScenario,
} from "./claudeScenario.ts";
import {
  createStandardProofAdapter,
  standardProofFilledWrite,
  STANDARD_PROOF_WRITE,
} from "./standardProofAdapter.ts";
import {
  createStandardProofCommandViewHost,
  standardProofCommandViewArtifactsAvailable,
} from "./standardProofCommandViewFixture.ts";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function runBash(
  execute: (
    command: {
      readonly executable: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ) => Promise<KernelCommandChild>,
  script: string,
) {
  const child = await execute(
    {
      executable: "/bin/bash",
      argv: ["bash", "--noprofile", "--norc", "-c", script],
      cwd: "/work",
      env: { HOME: "/home/claude", PATH: "/bin" },
    },
    new AbortController().signal,
  );
  const writer = child.stdin.getWriter();
  await writer.close();
  writer.releaseLock();
  const [stdout, stderr, exit] = await Promise.all([
    readAll(child.stdout),
    readAll(child.stderr),
    child.exited,
  ]);
  await child.dispose();
  return { stdout, stderr, exit };
}

describe.skipIf(!standardProofCommandViewArtifactsAvailable)(
  "standard proof command file views",
  () => {
    it("keeps trusted hook input canonical, inherits views through Bash, and transitions nested git before reading", async () => {
      const database = createProofTestStorage();
      const proof = createProofFilesystemHost(database.storage);
      const gateway = createStandardProofAdapter(
        database.storage,
        "command-views",
        undefined,
        proof.persistence.storage,
      );
      let programs: ReturnType<typeof createStandardProofCommandViewHost> | undefined;
      const machineCalls: string[] = [];
      try {
        await gateway.prepare();
        proof.fs.fs.writeFileSync(CLAUDE_TOOL_FILE, STANDARD_PROOF_WRITE, "utf8");
        proof.fs.fs.writeFileSync(CLAUDE_HOOK_COMMAND_LOG, "", "utf8");
        for (const path of ["/bin/bash", "/bin/cat", "/bin/git"]) {
          proof.fs.fs.writeFileSync(path, "", "utf8");
          proof.filesystem.chmod(path, 0o755);
        }

        programs = createStandardProofCommandViewHost({
          filesystem: proof.filesystem,
          wakes: proof.wakes,
          selectFileBytes: gateway.selectFileBytes,
        });
        const machine: KernelCommandForwarder = {
          async spawn(command) {
            machineCalls.push(command.executable);
            throw new Error("Command-view proof must remain in the isolate");
          },
        };
        const trusted = createComputerCommands({
          kernel: {
            host: programs.host,
            filesystem: proof.filesystem,
            fileBytes: canonicalFileByteSelection,
            home: "/home/claude",
          },
          escalation: new ComputerEscalationTable([
            { id: "hook-bash-would-escalate", executable: "/bin/bash" },
          ]),
          machine,
        });
        const scenario = createClaudeHookScenario();
        const hookService = createHookService({
          registrations: scenario.registrations,
          commands: gateway.commands(trusted.isolate),
          generated: {
            async invoke() {
              throw new Error("Command proof did not expect a script hook");
            },
          },
          capacity: programs.capacity,
        });
        const payload = {
          hook_event_name: "PreToolUse",
          session_id: "native-claude-command-view-session",
          cwd: "/work",
          tool_name: "Write",
          tool_input: claudeToolScript().input,
        };
        const hook = await hookService.invoke("claude-pre-tool-use-command", payload, {
          signal: new AbortController().signal,
          cwd: "/work",
          env: { HOME: "/home/claude", PATH: "/bin" },
        });
        expect(hook.exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
        expect(hook.stdout).toEqual(new Uint8Array());
        expect(new TextDecoder().decode(hook.stderr)).toBe(
          `{{secret:API_TOKEN}}\n{{secret:VAULT_TOKEN}}\n`,
        );
        expect(proof.fs.fs.readFileSync(CLAUDE_HOOK_COMMAND_LOG, "utf8")).toBe(
          `${JSON.stringify(payload)}\n`,
        );
        expect(proof.fs.fs.readFileSync(CLAUDE_TOOL_FILE, "utf8")).toBe(STANDARD_PROOF_WRITE);

        const canonical = await runBash(
          trusted.isolate.exec,
          [
            `cat ${CLAUDE_TOOL_FILE}`,
            `cat ${CLAUDE_TOOL_FILE} | cat`,
            `exec cat ${CLAUDE_TOOL_FILE}`,
          ].join("\n"),
        );
        expect(canonical).toMatchObject({
          stdout: bytes(STANDARD_PROOF_WRITE.repeat(3)),
          stderr: new Uint8Array(),
          exit: { exitCode: 0, signal: 0, coreDumped: false },
        });

        const raw = new KernelCommandExecutor({
          host: programs.host,
          filesystem: proof.filesystem,
          forwarder: machine,
        });
        programs.selectedExecutables.length = 0;
        const filled = await runBash(
          raw.spawn,
          [
            `cat ${CLAUDE_TOOL_FILE}`,
            `cat ${CLAUDE_TOOL_FILE} | cat`,
            `exec cat ${CLAUDE_TOOL_FILE}`,
          ].join("\n"),
        );
        expect(filled).toMatchObject({
          stdout: bytes(standardProofFilledWrite().repeat(3)),
          stderr: new Uint8Array(),
          exit: { exitCode: 0, signal: 0, coreDumped: false },
        });
        expect(programs.selectedExecutables).toContain("/bin/bash");
        expect(programs.selectedExecutables.filter((path) => path === "/bin/cat")).toHaveLength(4);
        expect(proof.fs.fs.readFileSync(CLAUDE_TOOL_FILE, "utf8")).toBe(STANDARD_PROOF_WRITE);

        programs.selectedExecutables.length = 0;
        const git = await runBash(raw.spawn, `exec /bin/git ${CLAUDE_TOOL_FILE}`);
        expect(git).toMatchObject({
          stdout: bytes(STANDARD_PROOF_WRITE),
          stderr: new Uint8Array(),
          exit: { exitCode: 0, signal: 0, coreDumped: false },
        });
        expect(programs.selectedExecutables.at(-1)).toBe("/bin/git");
        expect(programs.gitReadViews).toEqual(["canonical"]);
        expect(proof.fs.fs.readFileSync(CLAUDE_TOOL_FILE, "utf8")).toBe(STANDARD_PROOF_WRITE);
        expect(machineCalls).toEqual([]);
        expect(programs.capacity.active).toBe(0);
        expect(programs.host.processes.size).toBe(0);
        expect(proof.wakes.size).toBe(0);
        expect(gateway.inspect().gateway.commandEnvironments).toBe(1);

        const filledView = gateway.selectFileBytes({
          executable: "/bin/bash",
          filesystem: proof.filesystem,
        });
        proof.filesystem.setFileBytes(filledView);
        const fd = proof.filesystem.open(CLAUDE_TOOL_FILE, KernelOpenFlags.O_RDONLY);
        try {
          expect(proof.filesystem.read(fd, new Uint8Array(1), null)).toBe(1);
          const offset = proof.filesystem.descriptors.get(fd).offset;
          await expect(
            trusted.isolate.exec(
              {
                executable: "/bin/bash",
                argv: ["bash", "-c", "true"],
                cwd: "/work",
                env: { PATH: "/bin" },
              },
              new AbortController().signal,
            ),
          ).rejects.toMatchObject({ code: "ENOTSUP" });
          expect(proof.filesystem.descriptors.get(fd).offset).toBe(offset);
          expect(programs.host.processes.size).toBe(0);
          expect(programs.capacity.active).toBe(0);
        } finally {
          proof.filesystem.close(fd);
          proof.filesystem.setFileBytes(canonicalFileByteSelection);
        }
      } finally {
        gateway.close();
        await programs?.host.processes.dispose();
        proof.filesystem.dispose();
        proof.persistence.dispose();
        proof.wakes.dispose();
        database.close();
      }
    });
  },
);
