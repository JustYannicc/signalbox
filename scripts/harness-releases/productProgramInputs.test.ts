import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, expect, it } from "vite-plus/test";
import {
  applyGitTemplateSubstitutions,
  mountAospkgTar,
  readTarMember,
  safeRelative,
  sha256,
  verifyPinnedBytes,
  writePinnedTarFiles,
} from "./productProgramArchive.ts";
import { fetchPinned, parseProgramManifest } from "./productProgramAssets.ts";
import { assertPreparedShape } from "./productProgramShape.ts";
import { fetchProductProgramInputs } from "./productProgramInputs.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});

function digest(bytes: Uint8Array) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory() {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "product-program-inputs-"),
  );
  directories.push(directory);
  return directory;
}

it("accepts only a complete, HTTPS release asset pin", () => {
  const bytes = new TextEncoder().encode("program");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      programs: {
        bash: {
          url: "https://github.com/JustYannicc/signalbox/releases/download/pinned/bash.wasm",
          bytes: bytes.length,
          sha256: digest(bytes),
          provenance: {
            url: "https://github.com/JustYannicc/signalbox/releases/download/pinned/bash.json",
            bytes: 2,
            sha256: "a".repeat(64),
            sourceUrl: "https://github.com/JustYannicc/signalbox/blob/pinned/bash.json",
          },
        },
      },
    }),
  );
  expect(parseProgramManifest(manifest).programs.bash).toMatchObject({
    bytes: bytes.length,
    sha256: digest(bytes),
    provenance: { sourceUrl: "https://github.com/JustYannicc/signalbox/blob/pinned/bash.json" },
  });
  expect(() =>
    parseProgramManifest(
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          programs: { bash: { url: "http://example.invalid/a", bytes: 1, sha256: "a".repeat(64) } },
        }),
      ),
    ),
  ).toThrow("PRODUCT_PROGRAM_URL_INVALID");
});

it("checks fetched bytes against their published size and digest", async () => {
  const bytes = new TextEncoder().encode("pinned bytes");
  const pin = {
    url: "https://programs.invalid/asset",
    bytes: bytes.length,
    sha256: digest(bytes),
  };
  const fetcher: typeof fetch = async () => new Response(bytes);
  expect(await fetchPinned(fetcher, pin, "asset")).toEqual(bytes);
  await expect(fetchPinned(async () => new Response("changed"), pin, "asset")).rejects.toThrow(
    "PRODUCT_PROGRAM_HASH_MISMATCH:asset",
  );
  await expect(
    fetchPinned(async () => new Response(new Uint8Array(bytes.length + 1)), pin, "asset"),
  ).rejects.toThrow("PRODUCT_PROGRAM_DOWNLOAD_TOO_LARGE:asset");
});

it("inspects WASM ABI through the public infra CLI and rejects invalid modules", async () => {
  const root = await temporaryDirectory();
  const file = NodePath.join(root, "module.wasm");
  const entry = NodePath.resolve(
    import.meta.dirname,
    "../../apps/cloud/infra/harnessReleases/productProgramInputs.ts",
  );
  await NodeFSP.writeFile(file, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const { stdout } = await execFile(process.execPath, [entry, "--inspect-wasm", file], {
    encoding: "utf8",
  });
  expect(JSON.parse(stdout)).toEqual({ imports: [], exports: [] });
  await NodeFSP.writeFile(file, "invalid WASM");
  await expect(execFile(process.execPath, [entry, "--inspect-wasm", file])).rejects.toMatchObject({
    code: 1,
  });
});

it("gets current artifact pins through the public infra boundary", async () => {
  const entry = NodePath.resolve(
    import.meta.dirname,
    "../../apps/cloud/infra/harnessReleases/productProgramInputs.ts",
  );
  const { stdout } = await execFile(
    process.execPath,
    ["--experimental-strip-types", entry, "--describe"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const snapshot = JSON.parse(stdout);
  expect(Object.keys(snapshot.files).sort()).toEqual([
    "bash",
    "busybox",
    "git",
    "jq",
    "productBusybox",
    "ripgrep",
    "sed",
    "ugrep",
  ]);
  expect(Object.keys(snapshot.coreutils.commands).sort()).toEqual([
    "cp",
    "echo",
    "head",
    "ls",
    "mkdir",
    "mv",
    "printf",
    "pwd",
    "rm",
    "tail",
    "uniq",
    "wc",
  ]);
  expect(snapshot.commandExecutablePaths).toHaveLength(52);
  expect(snapshot.commandExecutablePaths).toEqual(
    expect.arrayContaining(["/bin/bash", "/usr/bin/bash", "/bin/claude", "/usr/bin/claude"]),
  );
  const prepared = {
    schemaVersion: 1 as const,
    commandExecutablePathCount: snapshot.commandExecutablePaths.length,
    commandExecutablePaths: snapshot.commandExecutablePaths,
    gitTemplateFileCount: snapshot.gitTemplates.files.length,
    programs: [
      "bash",
      "busyboxCat",
      "busyboxApplets",
      "productBusyboxApplets",
      "ripgrep",
      "coreutils",
      "git",
      "sed",
      "jq",
      "ugrep",
    ],
    coreutils: Object.keys(snapshot.coreutils.commands),
  };
  expect(() => assertPreparedShape(prepared, snapshot)).not.toThrow();
  expect(() =>
    assertPreparedShape({ ...prepared, commandExecutablePathCount: 26 }, snapshot),
  ).toThrow("PRODUCT_PROGRAM_PREPARER_SHAPE_MISMATCH");
  expect(() =>
    assertPreparedShape(
      {
        ...prepared,
        commandExecutablePaths: [...prepared.commandExecutablePaths.slice(1), "/bin/unexpected"],
      },
      snapshot,
    ),
  ).toThrow("PRODUCT_PROGRAM_PREPARER_SHAPE_MISMATCH");
  expect(snapshot.gitTemplates.files).toHaveLength(16);
  expect(snapshot.gitTemplates.files[0]).toMatchObject({
    relativeInstallPath: "description",
    sourceMember: "git-2.53.0/templates/description",
    path: "/usr/share/git-core/templates/description",
    assetPath: "git-templates/files/usr/share/git-core/templates/description",
  });
  expect(snapshot.gitTemplates.directories).toHaveLength(3);
  expect(snapshot.coreutilsProvenance).toMatchObject({
    file: "coreutils.provenance.json",
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});

it("refuses paths inside the checkout before creating output", async () => {
  const directory = await temporaryDirectory();
  const repository = NodePath.join(directory, "checkout");
  const output = NodePath.join(repository, "programs");
  await NodeFSP.mkdir(repository);
  await expect(fetchProductProgramInputs(output, { repository })).rejects.toThrow(
    "PRODUCT_PROGRAM_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT",
  );
  await expect(NodeFSP.stat(repository)).resolves.toBeDefined();
  await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses nested checkout outputs and outside paths whose parent resolves into the checkout", async () => {
  const directory = await temporaryDirectory();
  const repository = NodePath.join(directory, "checkout");
  const nested = NodePath.join(repository, "nested");
  const alias = NodePath.join(directory, "alias");
  await NodeFSP.mkdir(nested, { recursive: true });
  await NodeFSP.symlink(nested, alias);
  for (const parent of [nested, alias]) {
    const output = NodePath.join(parent, "programs");
    await expect(fetchProductProgramInputs(output, { repository })).rejects.toThrow(
      "PRODUCT_PROGRAM_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT",
    );
    await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("retains the pinned inputs and rejection record after a failed asset download", async () => {
  const directory = await temporaryDirectory();
  const output = NodePath.join(directory, "programs");
  await expect(
    fetchProductProgramInputs(output, { fetch: async () => new Response("changed manifest") }),
  ).rejects.toThrow("PRODUCT_PROGRAM_HASH_MISMATCH");
  const failure = JSON.parse(await NodeFSP.readFile(NodePath.join(output, "failure.json"), "utf8"));
  expect(failure).toMatchObject({ status: "rejected" });
  expect(await NodeFSP.stat(NodePath.join(output, "program-pins.json"))).toBeDefined();
  await expect(NodeFSP.stat(NodePath.join(output, "verified-inputs.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("reads only named tar members and writes them after size and hash checks", async () => {
  const directory = await temporaryDirectory();
  const source = NodePath.join(directory, "source");
  const root = NodePath.join(directory, "programs");
  const archive = NodePath.join(directory, "programs.tar");
  await NodeFSP.mkdir(NodePath.join(source, "bin"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "bin/echo"), "echo wasm");
  await NodeFSP.mkdir(root);
  await execFile("tar", ["-cf", archive, "-C", source, "./bin/echo"]);
  const bytes = new TextEncoder().encode("echo wasm");
  await writePinnedTarFiles({
    archivePath: archive,
    root,
    files: [
      {
        member: "./bin/echo",
        path: "coreutils/echo.wasm",
        bytes: bytes.length,
        sha256: digest(bytes),
        mode: 0o444,
      },
    ],
  });
  expect(await NodeFSP.readFile(NodePath.join(root, "coreutils/echo.wasm"), "utf8")).toBe(
    "echo wasm",
  );
  await expect(
    writePinnedTarFiles({
      archivePath: archive,
      root,
      files: [
        {
          member: "./bin/echo",
          path: "../escape.wasm",
          bytes: bytes.length,
          sha256: digest(bytes),
          mode: 0o444,
        },
      ],
    }),
  ).rejects.toThrow("PRODUCT_PROGRAM_TAR_OUTPUT_PATH_INVALID");
  await expect(readTarMember(archive, "../../escape")).rejects.toThrow(
    "PRODUCT_PROGRAM_TAR_MEMBER_INVALID",
  );
});

it("rejects modified tar members before writing output", async () => {
  const directory = await temporaryDirectory();
  const source = NodePath.join(directory, "source");
  const root = NodePath.join(directory, "programs");
  const archive = NodePath.join(directory, "programs.tar");
  await NodeFSP.mkdir(NodePath.join(source, "bin"), { recursive: true });
  await NodeFSP.mkdir(root);
  await NodeFSP.writeFile(NodePath.join(source, "bin/echo"), "changed");
  await execFile("tar", ["-cf", archive, "-C", source, "./bin/echo"]);
  const expected = new TextEncoder().encode("original");
  await expect(
    writePinnedTarFiles({
      archivePath: archive,
      root,
      files: [
        {
          member: "./bin/echo",
          path: "coreutils/echo.wasm",
          bytes: expected.length,
          sha256: digest(expected),
          mode: 0o444,
        },
      ],
    }),
  ).rejects.toThrow("PRODUCT_PROGRAM_HASH_MISMATCH:./bin/echo");
  await expect(NodeFSP.stat(NodePath.join(root, "coreutils/echo.wasm"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("mounts pinned AgentOS packages and rejects malformed layouts", () => {
  const packageBytes = Buffer.alloc(19);
  Buffer.from([0x89, 0x41, 0x4f, 0x53]).copy(packageBytes, 0);
  packageBytes.writeUInt16LE(2, 4);
  packageBytes.writeUInt32LE(1, 8);
  packageBytes.writeUInt32LE(1, 12);
  packageBytes.set([7, 8, 9], 16);
  expect([...mountAospkgTar(packageBytes)]).toEqual([9]);
  expect(() => mountAospkgTar(new Uint8Array(16))).toThrow("PRODUCT_PROGRAM_AOSPKG_HEADER_INVALID");
  packageBytes.writeUInt16LE(3, 4);
  expect(() => mountAospkgTar(packageBytes)).toThrow("PRODUCT_PROGRAM_AOSPKG_LAYOUT_INVALID");
});

it("applies the pinned Git template substitutions to first-line shell paths", () => {
  const source = new TextEncoder().encode(
    "#!/usr/bin/sh\n@SHELL_PATH@ @PERL_PATH@\n#!/usr/bin/env sh\n",
  );
  expect(
    new TextDecoder().decode(applyGitTemplateSubstitutions("hooks/pre-commit.sample", source)),
  ).toBe("#!/bin/sh\n/bin/sh perl\n#!/usr/bin/env sh\n");
  expect(safeRelative("git-templates/files/usr/share/git-core/templates/description")).toBe(true);
  expect(safeRelative("/usr/share/git-core/templates")).toBe(false);
  expect(safeRelative("git-templates/../escape")).toBe(false);
  expect(() =>
    verifyPinnedBytes(source, { bytes: source.length, sha256: "0".repeat(64) }, "fixture"),
  ).toThrow("PRODUCT_PROGRAM_HASH_MISMATCH:fixture");
  expect(sha256(source)).toBe(digest(source));
});
