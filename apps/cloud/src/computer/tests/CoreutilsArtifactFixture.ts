// @effect-diagnostics nodeBuiltinImport:off - reads only locally prepared, hash-pinned WASM artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import type { KernelPosixOptions } from "../../kernel/KernelFileSystem.ts";
import { createKernelCoreutilsHost } from "../../kernel/KernelCoreutilsHost.ts";
import type { KernelCoreutilsCall, KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

const commands = ["head", "tail", "ls", "mkdir", "rm", "cp", "mv", "printf", "pwd"] as const;
type Command = (typeof commands)[number];
type CommandArtifact = { readonly bytes: number; readonly sha256: string };
type Provenance = {
  readonly version: string;
  readonly commands: Readonly<Record<string, CommandArtifact>>;
};

const provenancePath = NodeURL.fileURLToPath(
  new URL("../../../infra/kernelPrograms/coreutils/provenance.json", import.meta.url),
);
const provenance = JSON.parse(NodeFS.readFileSync(provenancePath, "utf8")) as Provenance;
const artifactDirectory =
  NodeProcess.env.SIGNALBOX_COREUTILS_ARTIFACT_DIR ??
  NodeURL.fileURLToPath(
    new URL("../../../../../.t3/issue-1263/programs/coreutils/", import.meta.url),
  );
const artifactPaths = Object.fromEntries(
  commands.map((command) => [command, NodePath.join(artifactDirectory, `${command}.wasm`)]),
) as Record<Command, string>;
export const coreutilsArtifactsAvailable = commands.every((command) =>
  NodeFS.existsSync(artifactPaths[command]),
);
if (!coreutilsArtifactsAvailable && NodeProcess.env.SIGNALBOX_REQUIRE_COREUTILS_ARTIFACTS === "1") {
  throw new Error(
    `SIGNALBOX_REQUIRE_COREUTILS_ARTIFACTS=1 requires the pinned ${commands.join(", ")} coreutils artifacts`,
  );
}

const modules = coreutilsArtifactsAvailable ? loadModules() : undefined;

export function coreutilsModule(command: Command): WebAssembly.Module {
  const module = modules?.[command];
  if (module === undefined) throw new Error("Pinned coreutils artifacts are unavailable");
  return module;
}

export async function runCoreutilsCommand(
  command: Command,
  args: readonly string[],
  prepare: ((fixture: ReturnType<typeof childBusyboxFixture>) => void) | undefined,
  verify: (run: CoreutilsRun) => void,
  options: { readonly posix?: KernelPosixOptions | false } = {},
): Promise<void> {
  const argv = [`/bin/${command}`, ...args];
  const fixture = childBusyboxFixture({ args: argv, env: { PATH: "/bin" }, ...options });
  prepare?.(fixture);
  const env = Object.freeze({ ...fixture.context.env, PATH: "/bin", PWD: fixture.filesystem.cwd });
  const context = { ...fixture.context, env };
  const owner = createKernelCoreutilsHost({ context });
  const requests: (KernelSyscallRequest | KernelCoreutilsCall)[] = [];
  const port: KernelCoreutilsPort = {
    call: async (request) => {
      requests.push(request);
      return structuredClone(await owner.port.call(structuredClone(request)));
    },
    callCoreutils: async (request) => {
      requests.push(request);
      return structuredClone(await owner.port.callCoreutils(structuredClone(request)));
    },
  };

  try {
    const result = await createChildCoreutils({
      module: modules![command],
      port,
      args: argv,
      env,
    }).run();
    expectExit(result);
    const stderr = fixture.stderr();
    if (stderr !== "") throw new Error(`Coreutils wrote to stderr: ${stderr}`);
    const copied = requests.map((request) =>
      request.regions.reduce((size, region) => size + region.bytes.byteLength, 0),
    );
    if (copied.length === 0) throw new Error("Coreutils made no host calls");
    for (const [index, size] of copied.entries()) {
      if (size >= requests[index]!.memorySize || size > 16 * 1024 * 1024) {
        throw new Error(`Coreutils copied an invalid memory range: ${size} bytes`);
      }
    }
    verify({
      fixture,
      requests,
      result,
      stdout: new TextDecoder().decode(fixture.stdout()),
      stderr,
    });
  } finally {
    await owner.close();
    await fixture.close();
  }
}

interface CoreutilsRun {
  readonly fixture: ReturnType<typeof childBusyboxFixture>;
  readonly requests: readonly (KernelSyscallRequest | KernelCoreutilsCall)[];
  readonly result: ReturnType<typeof exited>;
  readonly stdout: string;
  readonly stderr: string;
}

function expectExit(result: ReturnType<typeof exited>): void {
  if (result.exitCode !== 0 || result.signal !== 0 || result.coreDumped) {
    throw new Error(`Coreutils exited unexpectedly: ${JSON.stringify(result)}`);
  }
}

function loadModules(): Record<Command, WebAssembly.Module> {
  const loaded = {} as Record<Command, WebAssembly.Module>;
  for (const command of commands) {
    const pin = provenance.commands[command];
    if (pin === undefined) throw new Error(`Coreutils provenance does not pin ${command}`);
    const bytes = new Uint8Array(NodeFS.readFileSync(artifactPaths[command]));
    if (
      bytes.byteLength !== pin.bytes ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
    ) {
      throw new Error(`Coreutils ${command} artifact does not match provenance`);
    }
    loaded[command] = new WebAssembly.Module(bytes);
  }
  return loaded;
}
