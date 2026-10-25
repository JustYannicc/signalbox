// @effect-diagnostics nodeBuiltinImport:off - exercise standalone Node CI tooling with isolated temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "@effect/vitest";
import {
  SOURCE_PIN,
  RELEASE_ID,
  RELEASE_TAG,
  digest,
  downloadArchive,
  json,
  record,
  verifyArchiveBytes,
  verifyInventories,
  writeJson,
} from "./ciArchive.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) await NodeFSP.rm(dir, { recursive: true, force: true });
});

async function inventoryFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-ci-archive-"));
  directories.push(root);
  const group = async (prefix: string, count: number) => {
    await NodeFSP.mkdir(NodePath.join(root, prefix), { recursive: true });
    const entries = [];
    for (let i = 0; i < count; i++) {
      const name = `${i}.js`;
      const bytes = Buffer.from(`module ${i}`);
      await NodeFSP.writeFile(NodePath.join(root, prefix, name), bytes);
      entries.push({ name, bytes: bytes.length, sha256: digest(bytes) });
    }
    return entries;
  };
  const hostModules = await group("host/generated", 8);
  const fixtureModules = await group("fixture", 3);
  const files = await group("host", 10);
  const manifest = JSON.stringify({
    paths: ["/startup"],
    mode: "facet",
    modules: { a: {}, b: {}, c: {} },
  });
  await NodeFSP.writeFile(NodePath.join(root, "fixture/manifest.json"), manifest);
  await writeJson(NodePath.join(root, "inventory.json"), {
    sourcePin: SOURCE_PIN,
    hostModules,
    fixtureModules,
    fixtureManifest: { bytes: manifest.length, sha256: digest(Buffer.from(manifest)) },
  });
  await writeJson(NodePath.join(root, "pinned-source-inventory.json"), {
    sourcePin: SOURCE_PIN,
    files,
  });
  return root;
}

it("checks every host, fixture, and source inventory byte before use", async () => {
  const root = await inventoryFixture();
  expect((await verifyInventories(root)).host).toHaveLength(8);
  for (const path of ["host/generated/7.js", "fixture/2.js", "host/9.js"]) {
    const target = NodePath.join(root, path);
    const previous = await NodeFSP.readFile(target);
    await NodeFSP.writeFile(target, "tampered");
    await expect(verifyInventories(root)).rejects.toThrow("Inventory mismatch");
    await NodeFSP.writeFile(target, previous);
  }
});

it("rejects an unpinned source or a duplicate/missing host inventory", async () => {
  const root = await inventoryFixture();
  const path = NodePath.join(root, "inventory.json");
  const inventory = record(await json(path));
  await writeJson(path, { ...inventory, sourcePin: "wrong-pin" });
  await expect(verifyInventories(root)).rejects.toThrow("Wrong source pin");
  await writeJson(path, { ...inventory, hostModules: [] });
  await expect(verifyInventories(root)).rejects.toThrow("Wrong inventory counts");
  const duplicates = Array.from({ length: 8 }, () => ({ name: "0.js" }));
  await writeJson(path, { ...inventory, hostModules: duplicates });
  await expect(verifyInventories(root)).rejects.toThrow("Duplicate inventory");
});

it("checks the fixed archive hash even when its size matches", () => {
  expect(() => verifyArchiveBytes(Buffer.alloc(21_893_763))).toThrow("SHA/size mismatch");
});

it("rejects arbitrary release tags before using the GitHub token", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    downloadArchive("owner/repo", "arbitrary", "fake-ci-token", "/unused"),
  ).rejects.toThrow("Invalid release source");
  expect(fetcher).not.toHaveBeenCalled();
});

const draft = {
  id: RELEASE_ID,
  tag_name: RELEASE_TAG,
  draft: true,
  target_commitish: SOURCE_PIN,
  assets: [{ id: 654194580, name: "pristine-r4-ci-inputs.tar.gz", size: 21893763 }],
};

it("resolves the frozen draft by ID and still rejects corrupt asset bytes", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(draft))
    .mockResolvedValueOnce(new Response("corrupt archive"));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    downloadArchive("owner/repo", RELEASE_TAG, "fake-ci-token", "/unused"),
  ).rejects.toThrow("Frozen archive SHA/size mismatch");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `https://api.github.com/repos/owner/repo/releases/${RELEASE_ID}`,
    "https://api.github.com/repos/owner/repo/releases/assets/654194580",
  ]);
});

it.each([
  { id: RELEASE_ID + 1 },
  { draft: false },
  { tag_name: "another-input" },
  { target_commitish: "another-source" },
])("rejects changed frozen draft metadata %j before downloading an asset", async (changed) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ...draft, ...changed }));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    downloadArchive("owner/repo", RELEASE_TAG, "fake-ci-token", "/unused"),
  ).rejects.toThrow("Frozen draft release metadata mismatch");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
