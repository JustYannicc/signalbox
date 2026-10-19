// @effect-diagnostics nodeBuiltinImport:off - static proof modules are packaged before Worker startup.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_BUSYBOX_VERSION } from "../../src/kernel/KernelBusyboxPrograms.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";

type ModuleType = "js" | "cjs" | "text" | "wasm";

export interface ProofProgramArtifactPaths {
  readonly bash: string;
  readonly busybox: string;
  readonly ripgrep: string;
}

export interface PreparedProofProgramModule {
  readonly name: string;
  readonly path: string;
  readonly type: ModuleType;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PreparedProofExecutableFile {
  readonly path: "/bin/bash" | "/bin/cat" | "/bin/rg";
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PreparedProofProgramModules {
  readonly modules: readonly PreparedProofProgramModule[];
  readonly executableFiles: readonly PreparedProofExecutableFile[];
  readonly executableCatalog: Readonly<
    Record<string, { readonly bytes: number; readonly sha256: string }>
  >;
  readonly imports: string;
  readonly configExpression: string;
  readonly external: readonly string[];
  readonly pins: Readonly<Record<string, { bytes: number; sha256: string; version: string }>>;
}

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Copies only pinned prebuilt modules into static Worker imports; it never compiles WASM. */
export async function prepareProofProgramModules(
  paths: ProofProgramArtifactPaths,
): Promise<PreparedProofProgramModules> {
  const [bash, busybox, ripgrep] = await Promise.all([
    readPinnedArtifact(paths.bash, KERNEL_BASH_ARTIFACT, "GNU Bash"),
    readPinnedArtifact(paths.busybox, KERNEL_BUSYBOX_ARTIFACT, "Nimbus BusyBox"),
    readPinnedArtifact(paths.ripgrep, KERNEL_RIPGREP_ARTIFACT, "ripgrep"),
  ]);
  const catBase64 = NodeBuffer.Buffer.from(busybox.bytes).toString("base64");
  const catBytes = new TextEncoder().encode(catBase64);
  const modules: PreparedProofProgramModule[] = [
    module("bash.wasm", "wasm", bash.bytes),
    module("busybox.wasm", "wasm", busybox.bytes),
    module("ripgrep.wasm", "wasm", ripgrep.bytes),
    module("cat-bytes.txt", "text", catBytes),
  ];
  const executableFiles: readonly PreparedProofExecutableFile[] = Object.freeze([
    executable("/bin/bash", bash.bytes),
    executable("/bin/cat", busybox.bytes),
    executable("/bin/rg", ripgrep.bytes),
  ]);
  const executableCatalog = Object.freeze(
    Object.fromEntries(
      executableFiles.map(({ path, bytes, sha256 }) => [path, { bytes: bytes.byteLength, sha256 }]),
    ),
  );
  const pins = Object.freeze({
    bash: {
      bytes: bash.bytes.byteLength,
      sha256: bash.sha256,
      version: KERNEL_BASH_ARTIFACT.version,
    },
    busybox: {
      bytes: busybox.bytes.byteLength,
      sha256: busybox.sha256,
      version: KERNEL_BUSYBOX_VERSION,
    },
    ripgrep: {
      bytes: ripgrep.bytes.byteLength,
      sha256: ripgrep.sha256,
      version: KERNEL_RIPGREP_ARTIFACT.version,
    },
  });
  return Object.freeze({
    modules: Object.freeze(modules),
    executableFiles,
    executableCatalog,
    imports: [
      'import bashModule from "./programs/bash.wasm";',
      'import busyboxModule from "./programs/busybox.wasm";',
      'import ripgrepModule from "./programs/ripgrep.wasm";',
      'import catBase64 from "./programs/cat-bytes.txt";',
    ].join("\n"),
    configExpression:
      "{ bash: bashModule, busybox: busyboxModule, ripgrep: ripgrepModule, busyboxCatBase64: catBase64 }",
    external: Object.freeze([
      "./programs/bash.wasm",
      "./programs/busybox.wasm",
      "./programs/ripgrep.wasm",
      "./programs/cat-bytes.txt",
    ]),
    pins,
  });
}

async function readPinnedArtifact(
  path: string,
  expected: { readonly bytes: number; readonly sha256: string },
  name: string,
) {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error(`${name} artifact path is required`);
  }
  const bytes = new Uint8Array(await NodeFSP.readFile(path));
  const digest = sha256(bytes);
  if (bytes.byteLength !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`${name} artifact does not match its pinned bytes and SHA-256`);
  }
  return { bytes, sha256: digest };
}

function module(name: string, type: ModuleType, bytes: Uint8Array): PreparedProofProgramModule {
  return Object.freeze({
    name: `programs/${name}`,
    path: `programs/${name}`,
    type,
    bytes,
    sha256: sha256(bytes),
  });
}

function executable(
  path: PreparedProofExecutableFile["path"],
  bytes: Uint8Array,
): PreparedProofExecutableFile {
  return Object.freeze({ path, bytes, sha256: sha256(bytes) });
}
