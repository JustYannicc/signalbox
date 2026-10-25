import * as NodeAssert from "node:assert/strict";
import type { KernelSyscallPort } from "../../../kernel/KernelSyscallPort.ts";
import type { KernelBusyboxPort } from "../../../kernel/KernelBusyboxPort.ts";
import type { KernelGitPort } from "../../../kernel/KernelGitPort.ts";
import type { ChildWorkerLoaderPort } from "../../../computer/WorkerLoaderDispatch.ts";
import type { CommandProgramCodes } from "../../../computer/CommandGateway.ts";
import { CHILD_PROGRAM_PATHS } from "../../../computer/ChildProgramSet.ts";
import type { ProgramSeed } from "../../HarnessSessionHost.ts";

const bytes = new TextEncoder().encode("controlled-command-body");
const exit = { exitCode: 0, signal: 0, coreDumped: false };
const code = { mainModule: "entry.js", modules: { "entry.js": "export default class {}" } };

export async function programFixture() {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const sha256 = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const codes: CommandProgramCodes = {
    bash: code,
    busyboxCat: code,
    busyboxApplets: code,
    sed: code,
    ripgrep: code,
    git: code,
    coreutils: {
      cp: code,
      echo: code,
      head: code,
      ls: code,
      mkdir: code,
      mv: code,
      printf: code,
      pwd: code,
      rm: code,
      tail: code,
    },
  };
  const seed: ProgramSeed = {
    sourceIdentity: "controlled-full-catalog",
    files: Object.fromEntries([
      ...Object.values(CHILD_PROGRAM_PATHS).map((path) => [
        path,
        {
          bytes: bytes.length,
          sha256,
          mode: 0o755,
          uid: 1000,
          gid: 1000,
        },
      ]),
      [
        "/usr/share/git-core/templates/description",
        {
          bytes: bytes.length,
          sha256,
          mode: 0o644,
          uid: 1000,
          gid: 1000,
        },
      ],
    ]),
    read: async () => bytes,
  };
  return { codes, seed };
}

export async function write(port: KernelSyscallPort, fd: number, text: string) {
  const payload = new TextEncoder().encode(text);
  const iovec = new Uint8Array(8);
  new DataView(iovec.buffer).setUint32(0, 32, true);
  new DataView(iovec.buffer).setUint32(4, payload.length, true);
  const result = await port.call({
    name: "fd_write",
    args: [fd, 0, 1, 8],
    memorySize: 4096,
    regions: [
      { pointer: 0, bytes: iovec },
      { pointer: 8, bytes: new Uint8Array(4) },
      { pointer: 32, bytes: payload },
    ],
  });
  NodeAssert.equal(result.kind, "return");
  if (result.kind !== "return") throw new Error("Unexpected exit");
  NodeAssert.equal(result.value, 0);
  NodeAssert.equal(
    new DataView(result.regions.find((region) => region.pointer === 8)!.bytes.buffer).getUint32(
      0,
      true,
    ),
    payload.length,
  );
}

async function replaceFile(port: KernelSyscallPort) {
  const path = new TextEncoder().encode("workspace/file.txt");
  const opened = await port.call({
    name: "path_open",
    args: [3, 0, 32, path.length, 8, 1n << 6n, 0n, 0, 0],
    memorySize: 4096,
    regions: [
      { pointer: 0, bytes: new Uint8Array(4) },
      { pointer: 32, bytes: path },
    ],
  });
  NodeAssert.equal(opened.kind, "return");
  if (opened.kind !== "return") throw new Error("Unexpected exit");
  NodeAssert.equal(opened.value, 0);
  const fd = new DataView(
    opened.regions.find((region) => region.pointer === 0)!.bytes.buffer,
  ).getUint32(0, true);
  await write(port, fd, "after\n");
  const closed = await port.call({ name: "fd_close", args: [fd], memorySize: 0, regions: [] });
  NodeAssert.deepEqual(closed, { kind: "return", value: 0, regions: [] });
}

/** Controlled command bodies exercise the real admitted syscall ports without WASM. */
export function commandLoader() {
  const commands: string[] = [];
  const identities: { pid: number; parentPid: number }[] = [];
  const loader: ChildWorkerLoaderPort = {
    async run(input, target) {
      const invocation = target as unknown as {
        host(): Promise<KernelGitPort & KernelBusyboxPort>;
        stopped(): void;
      };
      const port = await invocation.host();
      try {
        commands.push(input.command.executable);
        NodeAssert.equal(input.command.cwd, "/workspace");
        if (input.command.executable === "/usr/bin/git") {
          NodeAssert.deepEqual(input.command.argv, ["/usr/bin/git", "status", "--short"]);
          const result = await port.callGit({
            namespace: "nimbus_proc",
            name: "ids",
            args: [0],
            memorySize: 8,
            regions: [{ pointer: 0, bytes: new Uint8Array(8) }],
          });
          const view = new DataView(result.regions[0]!.bytes.buffer);
          NodeAssert.equal(view.getUint32(0, true), 1000);
          NodeAssert.equal(view.getUint32(4, true), 1000);
          await write(port, 1, " M file.txt\n");
        } else if (input.command.executable === "/bin/sed") {
          NodeAssert.deepEqual(input.command.argv, [
            "/bin/sed",
            "-i",
            "s/before/after/",
            "file.txt",
          ]);
          const identity = (field: number) =>
            port.callBusybox({
              name: "identity",
              args: [field],
              memorySize: 0,
              regions: [],
            });
          identities.push({ pid: (await identity(2)).value, parentPid: (await identity(3)).value });
          await replaceFile(port);
          await write(port, 2, "sed controlled stderr\n");
        } else throw new Error(`Unexpected local command ${input.command.executable}`);
        return exit;
      } finally {
        invocation.stopped();
      }
    },
  };
  return { loader, commands, identities };
}
