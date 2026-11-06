// @effect-diagnostics nodeBuiltinImport:off - loads only hash-pinned local WASM programs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import type { ChildWorkerCode } from "../ChildWorkerProgram.ts";
import {
  commandGatewayFixture,
  commandProgramCodes,
  readAll,
} from "./CommandGatewayAdmissionFixture.ts";
import { bashCredentials, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

type RunningBashHost = KernelBashPort & {
  readonly metadata: () => {
    readonly pid: number;
    readonly credentials: typeof bashCredentials;
    readonly residentByteLimit: number;
  };
  readonly forkSnapshot: () => Promise<KernelBashForkSource | undefined>;
};

type WasmPin = { readonly bytes: number; readonly sha256: string };
type CoreutilsProvenance = {
  readonly commands: Readonly<Record<string, WasmPin>>;
};

const provenancePath = new URL(
  "../../../infra/kernelPrograms/coreutils/provenance.json",
  import.meta.url,
);
const coreutilsProvenance = JSON.parse(
  NodeFS.readFileSync(provenancePath, "utf8"),
) as CoreutilsProvenance;
const headPin = coreutilsProvenance.commands.head;
if (headPin === undefined) throw new Error("Coreutils provenance is missing the head pin");
const pins = {
  bash: KERNEL_BASH_ARTIFACT,
  ugrep: KERNEL_UGREP_ARTIFACT,
  head: headPin,
};
const artifactPaths = {
  bash:
    NodeProcess.env.SIGNALBOX_BASH_ARTIFACT ??
    new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url),
  ugrep:
    NodeProcess.env.SIGNALBOX_UGREP_ARTIFACT ??
    new URL("../../../../../.t3/1071/programs/ugrep.wasm", import.meta.url),
  head:
    NodeProcess.env.SIGNALBOX_COREUTILS_HEAD_ARTIFACT ??
    new URL("../../../../../.t3/issue-1263/programs/coreutils/head.wasm", import.meta.url),
};
const artifactsAvailable = Object.values(artifactPaths).every((path) => NodeFS.existsSync(path));
if (NodeProcess.env.SIGNALBOX_REQUIRE_GREP_PIPELINE_ARTIFACTS === "1" && !artifactsAvailable) {
  throw new Error("The grep pipeline test requires pinned Bash, Ugrep, and coreutils head WASM");
}

function readPinnedArtifact(path: string | URL, pin: WasmPin, name: string) {
  const bytes = NodeFS.readFileSync(path);
  if (
    bytes.byteLength !== pin.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  ) {
    throw new Error("Pinned " + name + " artifact does not match its source pin");
  }
  return bytes;
}

function workerCode(name: string, bytes: Uint8Array): ChildWorkerCode {
  const mainModule = name + ".js";
  const wasm = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    mainModule,
    modules: {
      [mainModule]: "export default class {}",
      [name + ".wasm"]: { wasm },
    },
  };
}

it.skipIf(!artifactsAvailable)(
  "runs the captured grep pipeline in the isolate with pinned Ugrep and head",
  async () => {
    const bashBytes = readPinnedArtifact(artifactPaths.bash, pins.bash, "Bash");
    const ugrepBytes = readPinnedArtifact(artifactPaths.ugrep, pins.ugrep, "Ugrep");
    const headBytes = readPinnedArtifact(artifactPaths.head, pins.head, "coreutils head");
    const bashModule = new WebAssembly.Module(bashBytes);
    const ugrepModule = new WebAssembly.Module(ugrepBytes);
    const headModule = new WebAssembly.Module(headBytes);
    const dispatched: { readonly executable: string; readonly argv: readonly string[] }[] = [];
    const basePrograms = commandProgramCodes();
    const coreutils = Object.fromEntries(
      CHILD_COREUTILS_COMMANDS.map((command) => [command, basePrograms.coreutils[command]]),
    ) as Record<(typeof CHILD_COREUTILS_COMMANDS)[number], ChildWorkerCode>;
    coreutils.head = workerCode("head", headBytes);

    const fixture = commandGatewayFixture({
      capacityLimit: 4,
      programs: {
        ...basePrograms,
        ugrep: workerCode("ugrep", ugrepBytes),
        coreutils,
      },
      run: async (input, invocation) => {
        dispatched.push({ executable: input.command.executable, argv: [...input.command.argv] });
        try {
          if (input.command.executable === "/bin/bash") {
            const port = await invocation.host<RunningBashHost>();
            const metadata = port.metadata();
            const bash = createChildBash({
              module: bashModule,
              credentials: metadata.credentials,
              pid: metadata.pid,
              port,
              args: input.command.argv,
              env: input.command.env,
              snapshot: await port.forkSnapshot(),
              residentByteLimit: metadata.residentByteLimit,
            });
            try {
              return await bash.run();
            } finally {
              await bash.drain();
            }
          }
          if (input.command.executable === "/bin/grep") {
            return await createChildBusybox({
              module: ugrepModule,
              port: await invocation.host<KernelBusyboxPort>(),
              args: input.command.argv,
              env: input.command.env,
            }).run();
          }
          if (input.command.executable === "/bin/head") {
            return await createChildCoreutils({
              module: headModule,
              port: await invocation.host<KernelCoreutilsPort>(),
              args: input.command.argv,
              env: input.command.env,
            }).run();
          }
          throw new Error("Unexpected pipeline executable: " + input.command.executable);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    fixture.filesystem.mkdir("/workspace/docs");
    fixture.filesystem.mkdir("/workspace/node_modules");
    fixture.filesystem.mkdir("/bin");
    fixture.write("/bin/bash", "", 0o755);
    fixture.write("/bin/grep", "", 0o755);
    fixture.write("/bin/head", "", 0o755);
    fixture.write(
      "/workspace/docs/match.md",
      "wayfinder:map\nwayfinder:map again\nleave this text\n",
    );
    fixture.write("/workspace/docs/no-match.md", "unrelated\n");
    fixture.write("/workspace/node_modules/ignored.md", "wayfinder:map\n");
    const initialFiles = [
      fixture.read("/workspace/docs/match.md"),
      fixture.read("/workspace/docs/no-match.md"),
      fixture.read("/workspace/node_modules/ignored.md"),
    ];
    const script =
      "eval 'grep -rl \"wayfinder:map\" --include=*.md . 2>/dev/null | grep -v node_modules | head'";
    let child: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
    try {
      child = await fixture.gateway.exec(
        {
          executable: "/bin/bash",
          argv: ["bash", "--noprofile", "--norc", "-c", script],
          cwd: "/workspace",
          env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
        },
        fixture.controller.signal,
        undefined,
      );
      const writer = child.stdin.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
      const [stdout, stderr, status] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      await fixture.gateway.drain();

      const observation = {
        status,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
        dispatched,
        machineSpawns: fixture.machineSpawn.mock.calls.length,
      };
      expect(observation).toMatchObject({
        status: exited(),
        stdout: "./docs/match.md\n",
        stderr: "",
        machineSpawns: 0,
      });
      expect(dispatched).toContainEqual({
        executable: "/bin/grep",
        argv: [
          "grep",
          "--jobs=1",
          "--format=./%f%~",
          "-rl",
          "wayfinder:map",
          "--include=*.md",
          ".",
        ],
      });
      expect(dispatched).toContainEqual({
        executable: "/bin/grep",
        argv: ["grep", "--jobs=1", "-v", "node_modules"],
      });
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
      expect(
        dispatched.some(
          ({ executable, argv }) => executable === "/bin/grep" && argv.includes("-rl"),
        ),
      ).toBe(true);
      expect(
        dispatched.some(
          ({ executable, argv }) => executable === "/bin/grep" && argv.includes("-v"),
        ),
      ).toBe(true);
      expect(dispatched.some(({ executable }) => executable === "/bin/head")).toBe(true);
      expect([
        fixture.read("/workspace/docs/match.md"),
        fixture.read("/workspace/docs/no-match.md"),
        fixture.read("/workspace/node_modules/ignored.md"),
      ]).toEqual(initialFiles);
      expect(fixture.capacity.active).toBe(0);
    } finally {
      await child?.dispose();
      await fixture.close();
    }
  },
);
