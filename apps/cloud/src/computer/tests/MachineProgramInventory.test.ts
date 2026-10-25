import { expect, it } from "vite-plus/test";
import { indexMachinePrograms, type MachineProgramInventory } from "../MachineProgramInventory.ts";

const digest = `sha256:${"a".repeat(64)}` as const;

const entry = (path: string, type: "directory" | "file" | "fifo" = "directory") => ({
  path,
  type,
  size: "0",
  nlink: "1",
  atimeNs: "0",
  mtimeNs: "0",
  ctimeNs: "0",
  mode: type === "directory" ? 0o755 : 0o644,
  uid: 0,
  gid: 0,
});

const inventory: MachineProgramInventory = {
  format: "signalbox-machine-files-v1",
  imageRef: `ghcr.io/justyannicc/signalbox-runner@${digest}`,
  imageDigest: digest,
  platform: "linux/amd64",
  provenance: {
    sourceRevision: "b".repeat(40),
    sourceImageId: `sha256:${"c".repeat(64)}`,
    dockerfile: "apps/server/src/signalbox/runner/image/Dockerfile",
    captureSha256: "d".repeat(64),
  },
  path: ["/usr/bin"],
  excludedRoots: ["/proc"],
  entries: [
    entry("/"),
    entry("/usr"),
    entry("/usr/bin"),
    entry("/usr/bin/pipe", "fifo"),
    entry("/usr/bin/tool", "file"),
  ],
};

it("keeps excluded mount roots live-only and marks parent listings incomplete", () => {
  const index = indexMachinePrograms(inventory);

  expect(index.lookup(["/proc", "/usr/bin/tool", "/missing"])).toEqual([
    undefined,
    inventory.entries[4],
    undefined,
  ]);
  expect(index.readdir("/")).toBeUndefined();
  expect(index.needsLiveDirectory("/")).toBe(true);
  expect(index.readdir("/usr")?.map((item) => item.path)).toEqual(["/usr/bin"]);
  expect(index.readdir("/proc")).toBeUndefined();
  expect(index.isExcluded("/proc/1/status")).toBe(true);
});

it("preserves special file metadata in the inventory index", () => {
  const index = indexMachinePrograms(inventory);

  expect(index.readdir("/usr/bin")?.map((item) => [item.path, item.type])).toEqual([
    ["/usr/bin/pipe", "fifo"],
    ["/usr/bin/tool", "file"],
  ]);
});

const symlink = (path: string, target: string) => ({
  ...entry(path),
  type: "symlink" as const,
  target,
});
const withEntries = (...entries: MachineProgramInventory["entries"]) =>
  indexMachinePrograms({
    ...inventory,
    entries: [...inventory.entries, ...entries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  });

it("follows ancestor symlinks while preserving final lstat and directory aliases", () => {
  const index = withEntries(symlink("/bin", "usr/bin"), symlink("/usr/bin/link", "tool"));
  expect(index.lookup(["/bin/tool", "/bin/link"])).toEqual([
    { ...inventory.entries[4], path: "/bin/tool" },
    { ...symlink("/bin/link", "tool"), symlinkParent: "/usr/bin" },
  ]);
  expect(index.readlink("/bin/link")).toBe("tool");
  expect(index.readdir("/bin")?.map(({ path }) => path)).toEqual([
    "/bin/link",
    "/bin/pipe",
    "/bin/tool",
  ]);
});

it("walks symlinks before dot-dot inside another symlink target", () => {
  const index = withEntries(
    symlink("/alias", "usr/inner/.."),
    entry("/opt"),
    entry("/opt/deep"),
    entry("/opt/tool", "file"),
    symlink("/usr/inner", "/opt/deep"),
    symlink("/invalid", "/usr/bin/tool/.."),
  );
  expect(index.lookup(["/alias/tool"])[0]?.path).toBe("/alias/tool");
  expect(index.readdir("/alias")?.map(({ path }) => path)).toEqual(["/alias/deep", "/alias/tool"]);
  expect(index.lookup(["/invalid/tool"])).toEqual([undefined]);
});

it("requires live lookup through symlinks into excluded roots", () => {
  const index = withEntries(symlink("/live", "/proc"), symlink("/root-alias", "/"));
  expect(index.lookup(["/live"])[0]?.type).toBe("symlink");
  expect(index.isExcluded("/live")).toBe(false);
  expect(index.isExcluded("/live/1/status")).toBe(true);
  expect(index.needsLiveDirectory("/live")).toBe(true);
  expect(index.needsLiveDirectory("/root-alias")).toBe(true);
  expect(index.readdir("/live")).toBeUndefined();
});

it("bounds symlink traversal without following the final lstat link", () => {
  const index = withEntries(symlink("/loop-a", "loop-b"), symlink("/loop-b", "loop-a"));
  expect(index.lookup(["/loop-a"])[0]?.type).toBe("symlink");
  expect(() => index.lookup(["/loop-a/tool"])).toThrow(expect.objectContaining({ code: "ELOOP" }));
});
