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
