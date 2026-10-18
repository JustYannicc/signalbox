import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@agentos-software/coreutils";
const VERSION = "0.3.5";
const PACKAGE_URL = "https://registry.npmjs.org/@agentos-software/coreutils/-/coreutils-0.3.5.tgz";
const TARBALL_SHA512 =
  "0ebc6ad10b18608471c11bd9e6893874a8d7f0547564a2130a37a8a7dca814770037b35563d5e6e22aba7c2eec5f91580fe6facaa1b528aae0d1b9a0f6fefd84";
const TARBALL_SHA256 = "6dbfa3aa16077e697d71897adc1c6634c3045dae891c9c06264c751fe18fe7bc";
const AOSPKG_SHA256 = "a291a48ce90b0ad12d3937e771d9aaec37b289c1f5b047fe3d1d61151dbeee51";
const ABI_LOCK_PATH = join(scriptDirPlaceholder(), "import-abi.json");
const ABI_LOCK = JSON.parse(readFileSync(ABI_LOCK_PATH, "utf8"));
const SELECTED = ABI_LOCK.commands;
const ALLOWED_IMPORTS = new Set([
  "host_fs",
  "host_net",
  "host_user",
  "host_process",
  "wasi_snapshot_preview1",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2];
const outputDir = resolve(process.argv[3] ?? scriptDir);
const mkdirCandidatePath = process.argv[4];
if (mkdirCandidatePath === undefined) {
  throw new Error("Pass the rebuilt, pinned mkdir.wasm as the fourth argument");
}
const mkdirManifestPath = join(dirname(resolve(mkdirCandidatePath)), "mkdir.manifest.json");

let sourceBytes;
if (sourcePath !== undefined) {
  if (!existsSync(sourcePath))
    throw new Error(`Missing ${PACKAGE}@${VERSION} tarball: ${sourcePath}`);
  sourceBytes = readFileSync(sourcePath);
} else {
  const response = await fetch(PACKAGE_URL);
  if (!response.ok) throw new Error(`Could not download ${PACKAGE}@${VERSION}: ${response.status}`);
  sourceBytes = Buffer.from(await response.arrayBuffer());
}

assertHash("sha512", sourceBytes, TARBALL_SHA512, sourcePath ?? PACKAGE_URL);
assertHash("sha256", sourceBytes, TARBALL_SHA256, sourcePath ?? PACKAGE_URL);

const scratch = mkdtempSync(join(tmpdir(), "signalbox-coreutils-"));
try {
  const stagedTarball = join(scratch, "coreutils.tgz");
  writeFileSync(stagedTarball, sourceBytes);
  execFileSync("tar", [
    "-xzf",
    stagedTarball,
    "-C",
    scratch,
    "package/dist/package.aospkg",
    "package/LICENSE",
  ]);
  const containerPath = join(scratch, "package/dist/package.aospkg");
  const container = readFileSync(containerPath);
  assertHash("sha256", container, AOSPKG_SHA256, "package/dist/package.aospkg");

  if (
    container.length < 16 ||
    !container.subarray(0, 4).equals(Buffer.from([0x89, 0x41, 0x4f, 0x53]))
  ) {
    throw new Error("The coreutils artifact has an invalid .aospkg header");
  }
  const formatVersion = container.readUInt16LE(4);
  const manifestLength = container.readUInt32LE(8);
  const indexLength = container.readUInt32LE(12);
  const mountOffset = 16 + manifestLength + indexLength;
  if (formatVersion !== 1 || mountOffset > container.byteLength) {
    throw new Error(`Unexpected coreutils .aospkg header (format ${formatVersion})`);
  }

  const mountTar = join(scratch, "mount.tar");
  writeFileSync(mountTar, container.subarray(mountOffset));
  const programs = {};
  let totalBytes = 0;
  for (const [name, expected] of Object.entries(SELECTED)) {
    const bytes = execFileSync("tar", ["-xOf", mountTar, `./bin/${name}`], {
      maxBuffer: 8 * 1024 * 1024,
    });
    assertHash("sha256", bytes, expected.sha256, `./bin/${name}`);
    if (bytes.byteLength !== expected.bytes) {
      throw new Error(`Unexpected size for ./bin/${name}: ${bytes.byteLength}`);
    }
    const module = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(module);
    const actualImports = imports
      .map(({ module, name, kind }) => ({ module, name, kind }))
      .sort(compareImports);
    const pinnedImports = expected.imports
      .map(({ module, name, kind }) => ({ module, name, kind }))
      .sort(compareImports);
    if (JSON.stringify(actualImports) !== JSON.stringify(pinnedImports)) {
      throw new Error(`WASM import inventory mismatch for ${name}`);
    }
    const namespaces = [...new Set(imports.map((item) => item.module))].sort();
    for (const namespace of namespaces) {
      if (!ALLOWED_IMPORTS.has(namespace)) {
        throw new Error(`Unexpected import namespace in ${name}: ${namespace}`);
      }
    }
    programs[name] = {
      path: `bin/${name}.wasm`,
      bytes: bytes.byteLength,
      sha256: expected.sha256,
      imports: expected.imports,
    };
    totalBytes += bytes.byteLength;
    mkdirSync(join(outputDir, "bin"), { recursive: true });
    writeFileSync(join(outputDir, "bin", `${name}.wasm`), bytes);
  }

  const packagedMkdir = programs.mkdir;
  const mkdirPin = ABI_LOCK.overrides?.mkdir;
  if (mkdirPin === undefined) throw new Error("No rebuilt mkdir import and source pin is recorded");
  const mkdirBytes = readFileSync(mkdirCandidatePath);
  const mkdirSha256 = createHash("sha256").update(mkdirBytes).digest("hex");
  if (mkdirPin.sha256 !== undefined) {
    assertHash("sha256", mkdirBytes, mkdirPin.sha256, "rebuilt mkdir.wasm");
  }
  if (mkdirPin.bytes !== undefined && mkdirBytes.byteLength !== mkdirPin.bytes) {
    throw new Error(`Unexpected rebuilt mkdir size: ${mkdirBytes.byteLength}`);
  }
  const mkdirModule = await WebAssembly.compile(mkdirBytes);
  const mkdirImports = WebAssembly.Module.imports(mkdirModule)
    .map(({ module, name, kind }) => ({ module, name, kind }))
    .sort(compareImports);
  const pinnedMkdirImports = mkdirPin.imports
    .map(({ module, name, kind }) => ({ module, name, kind }))
    .sort(compareImports);
  if (JSON.stringify(mkdirImports) !== JSON.stringify(pinnedMkdirImports)) {
    throw new Error("Rebuilt mkdir WASM imports do not match the ABI pin");
  }
  const mkdirManifest = JSON.parse(readFileSync(mkdirManifestPath, "utf8"));
  if (
    mkdirManifest.artifact?.sha256 !== mkdirSha256 ||
    mkdirManifest.artifact?.bytes !== mkdirBytes.byteLength ||
    mkdirManifest.source?.commit !== mkdirPin.source.agentOsCommit ||
    mkdirManifest.source?.patch?.sha256 !== mkdirPin.source.umaskPatchSha256 ||
    mkdirManifest.source?.commandPatch?.sha256 !== mkdirPin.source.mkdirPatchSha256 ||
    mkdirManifest.source?.archiveSha256 !== mkdirPin.source.agentOsArchiveSha256 ||
    mkdirManifest.wasiLibc?.commit !== mkdirPin.source.wasiLibcCommit ||
    mkdirManifest.wasiLibc?.archiveSha256 !== mkdirPin.source.wasiLibcArchiveSha256 ||
    mkdirManifest.wasiLibc?.libcArchiveSha256 !== mkdirPin.source.libcArchiveSha256 ||
    mkdirManifest.source?.recipeSha256 !== mkdirPin.source.buildRecipeSha256 ||
    mkdirManifest.source?.cargoLockSha256 !== mkdirPin.source.effectiveCargoLockSha256
  ) {
    throw new Error("Rebuilt mkdir manifest differs from its pinned source and artifact inputs");
  }
  programs.mkdir = {
    path: "bin/mkdir.wasm",
    bytes: mkdirBytes.byteLength,
    sha256: mkdirSha256,
    imports: mkdirPin.imports,
  };
  totalBytes += mkdirBytes.byteLength - packagedMkdir.bytes;
  writeFileSync(join(outputDir, "bin", "mkdir.wasm"), mkdirBytes);
  copyFileSync(mkdirManifestPath, join(outputDir, "mkdir.manifest.json"));
  copyFileSync(join(scratch, "package/LICENSE"), join(outputDir, "LICENSE"));
  const provenance = {
    package: PACKAGE,
    version: VERSION,
    packageUrl: PACKAGE_URL,
    tarballSha512: TARBALL_SHA512,
    tarballSha256: TARBALL_SHA256,
    containerPath: "package/dist/package.aospkg",
    containerSha256: AOSPKG_SHA256,
    containerFormatVersion: formatVersion,
    agentOsAbiContractCommit: ABI_LOCK.abiContractCommit,
    npmBuildSourceCommit: mkdirPin.source.agentOsCommit,
    commandOverrides: {
      mkdir: {
        packageArtifact: packagedMkdir,
        buildManifest: {
          path: "mkdir.manifest.json",
          sha256: createHash("sha256").update(readFileSync(mkdirManifestPath)).digest("hex"),
        },
      },
    },
    extraction:
      "The selected static WASM binaries are loaded directly; the package container is not mounted at runtime.",
    totalBytes,
    commands: programs,
    unavailable: {
      find: "Not included in this coreutils package; GNU find is distributed by findutils.",
      sort: "Omitted from this first set because it imports host_process process-spawn and pipe operations.",
      bash: "Omitted: the package's bin/bash is an sh alias, not GNU Bash.",
    },
  };
  writeFileSync(join(outputDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(JSON.stringify({ outputDir, totalBytes, commands: Object.keys(programs) }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function assertHash(algorithm, bytes, expected, label) {
  const actual = createHash(algorithm).update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`${label} ${algorithm} mismatch: expected ${expected}, got ${actual}`);
  }
}

function compareImports(left, right) {
  const a = `${left.module}\0${left.name}\0${left.kind}`;
  const b = `${right.module}\0${right.name}\0${right.kind}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

function scriptDirPlaceholder() {
  return dirname(fileURLToPath(import.meta.url));
}
