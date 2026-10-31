import { createNodeFs } from "../../../../src/isolate/NodeFs.ts";
import { captureHarnessCProductFiles } from "../../../../src/harness/HarnessCProductCheckpoint.ts";
import type { ProductHostOptions } from "../../../../src/harness/HarnessCProductFacet.ts";
import type { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import type { HarnessFilesStoreResult } from "../../../../src/harness/HarnessFilesStore.ts";
import { assert, sha256 } from "./common.ts";

export type HostFiles = ProductHostOptions<unknown, unknown>["files"];
export function workspacePaths(files: KernelFileSystem) {
  const fs = createNodeFs(files).fs;
  const paths: string[] = [];
  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).map(String).sort()) {
      const path = `${directory}/${name}`;
      const entry = fs.lstatSync(path);
      if (entry.isDirectory()) visit(path);
      else {
        assert(entry.isFile() || entry.isSymbolicLink(), `Unsupported checkpoint entry ${path}`);
        paths.push(path.slice("/workspace/".length));
      }
    }
  }
  visit("/workspace");
  return paths;
}
export async function describeFiles(entries: HarnessFilesStoreResult["files"]) {
  return await Promise.all(
    entries.map(async (file) => ({
      path: file.path,
      kind: file.kind ?? "file",
      mode: file.mode,
      bytes: file.bytes.byteLength,
      sha256: await sha256(file.bytes),
      ...(file.kind === "symlink"
        ? { target: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) }
        : {}),
    })),
  );
}
export async function compareBeforeReadiness(
  files: KernelFileSystem,
  expected: HarnessFilesStoreResult["files"],
) {
  const fs = createNodeFs(files).fs;
  const observed = await Promise.all(
    expected.map(async (entry) => {
      const path = `/workspace/${entry.path}`;
      const stat = fs.lstatSync(path);
      const bytes = stat.isSymbolicLink()
        ? fs.readlinkSync(path, { encoding: "buffer" })
        : fs.readFileSync(path);
      assert(typeof bytes !== "string", "Pre-readiness comparison requires raw bytes");
      assert(
        stat.isSymbolicLink() === (entry.kind === "symlink"),
        `Restored kind changed: ${entry.path}`,
      );
      assert((stat.mode & 0o7777) === entry.mode, `Restored mode changed: ${entry.path}`);
      assert(
        bytes.byteLength === entry.bytes.byteLength &&
          (await sha256(bytes)) === (await sha256(entry.bytes)),
        `Restored bytes changed before readiness: ${entry.path}`,
      );
      return {
        path: entry.path,
        bytes: bytes.byteLength,
        sha256: await sha256(bytes),
        mode: entry.mode,
        kind: entry.kind ?? "file",
      };
    }),
  );
  const transcript = observed.filter(
    (entry) => entry.path.includes("/.codex/sessions/") && entry.path.endsWith(".jsonl"),
  );
  return {
    matched: true,
    entries: observed,
    transcript,
    index: observed.find((entry) => entry.path === ".git/index"),
  };
}
export function capture(filesOptions: HostFiles, threadId: string, files: KernelFileSystem) {
  return captureHarnessCProductFiles({
    files: filesOptions,
    threadId,
    paths: workspacePaths(files),
  });
}
