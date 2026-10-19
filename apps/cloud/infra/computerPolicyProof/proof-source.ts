import { COMPUTER_ISOLATE_POLICY } from "../../src/computer/EscalationPolicy.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import type { ChildWorkerLoaderPort } from "../../src/computer/WorkerLoaderDispatch.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KernelProgramRegistry, KernelWakeRegistry } from "../../src/kernel/KernelAbi.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "../../src/kernel/KernelCommandForwarder.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import { createSeededChildProgramCatalog } from "../childPrograms/runtime.ts";
import type { ChildProgramExecutableFile, ChildProgramSources } from "../childPrograms/prepare.ts";

const encoder = new TextEncoder();
const exitSuccess = { exitCode: 0, signal: 0, coreDumped: false } as const;

const PROGRAM_PINS = [
  { path: "/bin/bash", pin: KERNEL_BASH_ARTIFACT },
  { path: "/bin/cat", pin: KERNEL_BUSYBOX_ARTIFACT },
  { path: "/bin/rg", pin: KERNEL_RIPGREP_ARTIFACT },
] as const;

export interface ComputerPolicyProofInput {
  readonly filesystem: KernelFileSystem;
  readonly loader: ChildWorkerLoaderPort;
  readonly programs: ChildProgramSources;
  readonly executableFiles: readonly ChildProgramExecutableFile[];
}

/** Uses the current child catalog and pinned programs; machine calls are captured, never executed. */
export async function proveComputerPolicy(input: ComputerPolicyProofInput) {
  const files = await verifyExecutableFiles(input.executableFiles);
  input.filesystem.mkdir("/bin");
  input.filesystem.mkdir("/workspace");
  for (const { path, bytes } of files) writeNewFile(input.filesystem, path, bytes, 0o755);
  writeNewFile(input.filesystem, "/workspace/policy.txt", encoder.encode("needle\n"), 0o644);

  const registry = new KernelProgramRegistry();
  const wakes = new KernelWakeRegistry();
  const capacity = new ChildWorkerCapacity();
  const catalog = createSeededChildProgramCatalog({
    registry,
    filesystem: input.filesystem,
    loader: input.loader,
    capacity,
    programs: input.programs,
    hostname: "computer-policy-proof",
  });
  const host = new KernelProgramHost({ registry, wakes, programs: catalog.bindings });

  try {
    const normalMachine = machineCapture();
    const exactPolicy = new ComputerEscalationTable([], COMPUTER_ISOLATE_POLICY);
    const commands = createComputerCommands({
      kernel: { host, filesystem: input.filesystem },
      escalation: exactPolicy,
      machine: normalMachine.forwarder,
    });
    const bashControl = await runCommand(commands, {
      executable: "/bin/bash",
      argv: [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        "printf 'needle\\n' > policy.txt; /bin/cat policy.txt; /bin/rg -n needle policy.txt",
      ],
      cwd: "/workspace",
      env: { PATH: "/bin", PWD: "/workspace" },
    });
    assert(bashControl.exitCode === 0, "Pinned Bash control exited unsuccessfully");
    assert(bashControl.stderr === "", "Pinned Bash control wrote stderr");
    assert(bashControl.stdout === "needle\n1:needle\n", "Bash, cat and rg output differed");
    assert(normalMachine.commands.length === 0, "The real child control reached the machine port");

    const unboundCommand: KernelCommand = {
      executable: "sed",
      argv: ["captured-sed", "-n", "1p", "policy.txt"],
      cwd: "/workspace",
      env: { PATH: "/bin", PWD: "/workspace" },
    };
    assert(
      exactPolicy.decide(unboundCommand).kind === "isolate",
      "sed was not an isolate candidate",
    );
    const unboundResolution = host.resolve("sed");
    assert(
      unboundResolution.status === "error" && unboundResolution.error.code === "NOT_FOUND",
      "sed unexpectedly resolved in the current child catalog",
    );
    const forwardedChild = await commands.exec(unboundCommand, new AbortController().signal);
    await forwardedChild.dispose();
    assertOneCaptured(normalMachine.commands, unboundCommand, "Allowed unbound sed");

    const registeredOutsidePolicy: KernelCommand = {
      executable: "/bin/bash",
      argv: ["/bin/bash", "--noprofile", "--norc", "-c", "printf 'must-not-start\\n'"],
      cwd: "/workspace",
      env: { PATH: "/bin", PWD: "/workspace" },
    };
    assert(
      host.resolve("/bin/bash").status === "ok",
      "Pinned Bash was not registered in the current child catalog",
    );
    const outsidePolicyMachine = machineCapture();
    const outsidePolicyTable = new ComputerEscalationTable([], {
      isolateExecutables: ["sed"],
      default: "machine",
    });
    const outsidePolicyDecision = outsidePolicyTable.decide(registeredOutsidePolicy);
    assert(
      outsidePolicyDecision.kind === "machine" &&
        "reason" in outsidePolicyDecision &&
        outsidePolicyDecision.reason === "unsupported-executable",
      "Registered Bash outside the exact policy did not select the machine",
    );
    const outsidePolicyCommands = createComputerCommands({
      kernel: { host, filesystem: input.filesystem },
      escalation: outsidePolicyTable,
      machine: outsidePolicyMachine.forwarder,
    });
    const outsideChild = await outsidePolicyCommands.exec(
      registeredOutsidePolicy,
      new AbortController().signal,
    );
    await outsideChild.dispose();
    assertOneCaptured(
      outsidePolicyMachine.commands,
      registeredOutsidePolicy,
      "Registered Bash outside policy",
    );

    const orderedMachine = machineCapture();
    const orderedTable = new ComputerEscalationTable(
      [{ id: "explicit-bash-machine", executable: "/bin/bash" }],
      COMPUTER_ISOLATE_POLICY,
    );
    const orderedDecision = orderedTable.decide(registeredOutsidePolicy);
    assert(
      orderedDecision.kind === "machine" &&
        "ruleId" in orderedDecision &&
        orderedDecision.ruleId === "explicit-bash-machine",
      "Explicit machine rule did not win over the isolate policy",
    );
    const orderedCommands = createComputerCommands({
      kernel: { host, filesystem: input.filesystem },
      escalation: orderedTable,
      machine: orderedMachine.forwarder,
    });
    const orderedChild = await orderedCommands.exec(
      registeredOutsidePolicy,
      new AbortController().signal,
    );
    await orderedChild.dispose();
    assertOneCaptured(
      orderedMachine.commands,
      registeredOutsidePolicy,
      "Ordered Bash machine rule",
    );

    return {
      ok: true,
      childControl: {
        executables: ["/bin/bash", "/bin/cat", "/bin/rg"],
        stdout: bashControl.stdout,
        stderr: bashControl.stderr,
        exitCode: bashControl.exitCode,
      },
      allowedUnbound: { executable: "sed", resolution: "NOT_FOUND", forwarded: true },
      outsidePolicy: { executable: "/bin/bash", reason: "unsupported-executable", forwarded: true },
      orderedRule: { ruleId: "explicit-bash-machine", forwarded: true },
      machinePort: { kind: "forwarding-capture-only", vmProof: false },
    };
  } finally {
    await catalog.drain();
    await host.processes.dispose();
    wakes.dispose();
  }
}

function machineCapture() {
  const commands: KernelCommand[] = [];
  const forwarder: KernelCommandForwarder = {
    async spawn(command) {
      commands.push(command);
      return completedChild();
    },
  };
  return { commands, forwarder };
}

function completedChild(): KernelCommandChild {
  return {
    stdin: new WritableStream<Uint8Array>(),
    stdout: closedStream(),
    stderr: closedStream(),
    exited: Promise.resolve(exitSuccess),
    async signal() {
      return { status: "ok", value: undefined };
    },
    async dispose() {},
  };
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

async function runCommand(
  commands: ReturnType<typeof createComputerCommands>,
  command: KernelCommand,
) {
  const child = await commands.exec(command, new AbortController().signal);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      readText(child.stdout),
      readText(child.stderr),
      child.exited,
    ]);
    return { stdout, stderr, exitCode: exit.exitCode };
  } finally {
    await child.dispose();
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const text = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return output + text.decode();
      output += text.decode(item.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function verifyExecutableFiles(files: readonly ChildProgramExecutableFile[]) {
  assert(files.length === PROGRAM_PINS.length, "Expected exactly three pinned child programs");
  const byPath = new Map(files.map((file) => [file.path, file]));
  assert(byPath.size === PROGRAM_PINS.length, "Child program executable paths were duplicated");
  const verified = [];
  for (const { path, pin } of PROGRAM_PINS) {
    const file = byPath.get(path);
    assert(file !== undefined, `Missing pinned child program ${path}`);
    assert(file.bytes.byteLength === pin.bytes, `Pinned child program size differs for ${path}`);
    const actualSha256 = await sha256(file.bytes);
    assert(
      file.sha256 === pin.sha256 && actualSha256 === pin.sha256,
      `Pinned hash differs for ${path}`,
    );
    verified.push({ path, bytes: file.bytes });
  }
  return verified;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function writeNewFile(
  filesystem: KernelFileSystem,
  path: string,
  bytes: Uint8Array,
  mode: number,
): void {
  const fd = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_EXCL | KernelOpenFlags.O_WRONLY,
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = filesystem.write(fd, bytes.subarray(offset, offset + 64 * 1024), null);
      assert(written > 0, `Could not write pinned file ${path}`);
      offset += written;
    }
  } finally {
    filesystem.close(fd);
  }
}

function assertOneCaptured(
  captured: readonly KernelCommand[],
  expected: KernelCommand,
  label: string,
): void {
  assert(captured.length === 1, `${label} did not produce one machine forwarding capture`);
  assert(sameCommand(captured[0]!, expected), `${label} changed the captured command`);
}

function sameCommand(left: KernelCommand, right: KernelCommand): boolean {
  return (
    left.executable === right.executable &&
    left.cwd === right.cwd &&
    JSON.stringify(left.argv) === JSON.stringify(right.argv) &&
    JSON.stringify(left.env) === JSON.stringify(right.env)
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
