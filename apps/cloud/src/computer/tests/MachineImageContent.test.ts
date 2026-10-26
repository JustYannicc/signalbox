// @effect-diagnostics nodeBuiltinImport:off - hashes binary test captures without a live machine.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import { createComputerMachineFileSystem } from "../ComputerMachineFileSystem.ts";
import type { MachineFileSourceState, MachineFilesPort } from "../MachineFilesPort.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";

const bytes = Uint8Array.from([0, 255, 128, 10, 65]);
const hash = (value: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
function fixture(): MachineProgramInventory {
  const base = machineInventoryFixture([{ path: "/etc/config", mode: 0o644, uid: 0, gid: 0 }]);
  const metadata = {
    ...base,
    provenance: { ...base.provenance, snapshotSha256: "1".repeat(64) },
    entries: base.entries.map((entry) =>
      entry.path === "/etc/config" ? { ...entry, size: "5" } : entry,
    ),
  };
  return {
    ...metadata,
    imageContent: {
      format: "signalbox-machine-image-content-v1",
      imageDigest: metadata.imageDigest,
      captureSha256: metadata.provenance.captureSha256,
      inventorySha256: hash(JSON.stringify(metadata)),
      includeRule: "regular-files-under-/etc",
      fileCount: 1,
      totalBytes: bytes.length,
      entries: [
        {
          path: "/etc/config",
          size: "5",
          sha256: hash(bytes),
          bytesBase64: Buffer.from(bytes).toString("base64"),
        },
      ],
    },
  };
}
function source(
  inventory = fixture(),
  state: MachineFileSourceState = { generation: null, generationAbsent: true, pristine: false },
) {
  const owner = new AbortController();
  const lookup = vi.fn<MachineFilesPort["lookup"]>(async (input) => ({
    generation: input.generation,
    results: [
      { id: "bytes", op: "readRange", offset: 0, bytesRead: 1, bytesBase64: "TQ==", eof: true },
    ],
  }));
  const files: MachineFilesPort = { current: () => state, markExecuted: async () => {}, lookup };
  return {
    ...createComputerMachineFileSystem({ inventory, files, signal: owner.signal }),
    lookup,
    owner,
  };
}

describe("immutable image content through the public lower filesystem", () => {
  it("reads exact binary ranges without a machine, preserving zero reads and EOF", async () => {
    const lower = source();
    expect(await lower.read("/etc/config", 0n, 100)).toEqual(bytes);
    expect(await lower.read("/etc/config", 1n, 3)).toEqual(bytes.slice(1, 4));
    expect(await lower.read("/etc/config", 5n, 10)).toEqual(new Uint8Array());
    expect(await lower.read("/etc/config", 500n, 10)).toEqual(new Uint8Array());
    expect(await lower.read("/etc/config", 0n, 0)).toEqual(new Uint8Array());
    const returned = await lower.read("/etc/config", 0n, 5);
    returned[0] = 99;
    expect(await lower.read("/etc/config", 0n, 5)).toEqual(bytes);
    expect(lower.lookup).not.toHaveBeenCalled();
  });

  it.each([
    { generation: 1, pristine: false },
    { generation: 1, pristine: true },
    { generation: 1, pristine: true, imageDigest: `sha256:${"a".repeat(64)}` },
  ])("falls back to live bytes for dirty or unrecognized image state %j", async (state) => {
    const lower = source(fixture(), state);
    expect(await lower.read("/etc/config", 0n, 5)).toEqual(Uint8Array.of(77));
    expect(lower.lookup).toHaveBeenCalledOnce();
  });

  it("serves a positively attested pristine generation", async () => {
    const inventory = fixture();
    const lower = source(inventory, {
      generation: 4,
      pristine: true,
      imageDigest: inventory.imageDigest,
    });
    expect(await lower.read("/etc/config", 0n, 5)).toEqual(bytes);
    expect(lower.lookup).not.toHaveBeenCalled();
  });

  it.each([
    { generation: null, pristine: false },
    {
      generation: null,
      generationAbsent: true,
      pristine: false,
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
  ] as const)(
    "does not use bytes for unknown or mismatched no-generation state %j",
    async (state) => {
      await expect(source(fixture(), state).read("/etc/config", 0n, 5)).rejects.toMatchObject({
        name: "KernelFileSystemUnavailable",
      });
    },
  );

  it("uses the live path for a missing sidecar entry or legacy inventory", async () => {
    const inventory = fixture();
    const lower = source(inventory, {
      generation: 1,
      pristine: true,
      imageDigest: inventory.imageDigest,
    });
    expect(await lower.read("/etc/other", 0n, 1)).toEqual(Uint8Array.of(77));
    const missing = source(
      {
        ...inventory,
        imageContent: { ...inventory.imageContent!, entries: [], fileCount: 0, totalBytes: 0 },
      },
      { generation: 1, pristine: true, imageDigest: inventory.imageDigest },
    );
    expect(await missing.read("/etc/config", 0n, 1)).toEqual(Uint8Array.of(77));
    expect(missing.lookup).toHaveBeenCalledOnce();
    const { imageContent: _content, ...legacy } = inventory;
    expect(
      await source(legacy, { generation: 1, pristine: true, imageDigest: legacy.imageDigest }).read(
        "/etc/config",
        0n,
        1,
      ),
    ).toEqual(Uint8Array.of(77));
  });

  it.each([
    "image",
    "inventory",
    "hash",
    "payload",
    "size",
    "duplicate",
    "outside",
    "noncanonical",
    "capture",
  ])("rejects %s tampering without serving bytes", async (kind) => {
    const inventory = fixture();
    const content = inventory.imageContent!;
    const first = content.entries[0]!;
    const changes: Partial<NonNullable<MachineProgramInventory["imageContent"]>> = {
      image: { imageDigest: `sha256:${"a".repeat(64)}` as const },
      inventory: { inventorySha256: "a".repeat(64) },
      capture: { captureSha256: "b".repeat(64) },
      duplicate: { entries: [first, first], fileCount: 2 },
      hash: { entries: [{ ...first, sha256: "bad" }] },
      payload: { entries: [{ ...first, bytesBase64: "AQIDBAU=" }] },
      size: { entries: [{ ...first, size: "6" }] },
      outside: { entries: [first, { ...first, path: "/usr/extra" }], fileCount: 2 },
      noncanonical: { entries: [first, { ...first, path: "/etc/../extra" }], fileCount: 2 },
    }[kind]!;
    const lower = source({ ...inventory, imageContent: { ...content, ...changes } });
    await expect(lower.read("/etc/config", 0n, 5)).rejects.toMatchObject({
      name: "KernelFileSystemUnavailable",
    });
  });

  it("fences cancellation and generation changes during asynchronous verification", async () => {
    const state = { generation: null, generationAbsent: true, pristine: false } as const;
    const cancelled = source(fixture(), state);
    const pending = cancelled.read("/etc/config", 0n, 5);
    cancelled.owner.abort(new Error("owner cancelled"));
    await expect(pending).rejects.toThrow("owner cancelled");
    const mutable: { generation: number | null; generationAbsent: true; pristine: boolean } = {
      ...state,
    };
    const changed = source(fixture(), mutable);
    const stale = changed.read("/etc/config", 0n, 5);
    mutable.generation = 2;
    await expect(stale).rejects.toMatchObject({ name: "KernelFileSystemUnavailable" });
  });

  it("falls back when the same generation becomes dirty during verification", async () => {
    const inventory = fixture();
    const state = { generation: 1, pristine: true, imageDigest: inventory.imageDigest };
    const lower = source(inventory, state);
    const read = lower.read("/etc/config", 0n, 5);
    state.pristine = false;
    expect(await read).toEqual(Uint8Array.of(77));
    expect(lower.lookup).toHaveBeenCalledOnce();
  });

  it("checks caller cancellation and invalid ranges", async () => {
    const lower = source();
    const caller = new AbortController();
    caller.abort(new Error("caller cancelled"));
    await expect(lower.read("/etc/config", 0n, 5, caller.signal)).rejects.toThrow(
      "caller cancelled",
    );
    await expect(
      lower.read("/etc/config", BigInt(Number.MAX_SAFE_INTEGER) + 1n, 5),
    ).rejects.toMatchObject({ code: "EOVERFLOW" });
    await expect(lower.read("/etc/config", -1n, 5)).rejects.toMatchObject({ code: "EOVERFLOW" });
    await expect(lower.read("/etc/config", 0n, -1)).rejects.toMatchObject({ code: "EINVAL" });
  });
});
