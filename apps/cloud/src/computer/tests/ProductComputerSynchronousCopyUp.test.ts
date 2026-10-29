import { log } from "evlog";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { imageContentInventory } from "./ImageContentFixture.ts";
import { withImageContentFixture } from "./ProductComputerImageContentFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("ProductComputer synchronous lower-file copy-up", () => {
  it("appends verified bytes across copy chunks and updates an already open descriptor", async () => {
    const original = Uint8Array.from({ length: 64 * 1024 + 17 }, (_, index) => index % 256);
    const inventory = imageContentInventory(original);
    const snapshot = JSON.stringify(inventory);
    await withImageContentFixture(
      async ({ filesystem, forbidden }) => {
        const { fs } = createNodeFs(filesystem);
        const fd = fs.openSync("/etc/config", "r");
        try {
          expect(await fs.promises.readFile("/etc/config")).toEqual(Buffer.from(original));
          fs.appendFileSync("/etc/config", Buffer.from([66, 0, 255]));
          const expected = Buffer.concat([original, Buffer.from([66, 0, 255])]);
          expect(fs.readFileSync("/etc/config")).toEqual(expected);
          const retained = Buffer.alloc(expected.byteLength);
          expect(fs.readSync(fd, retained, 0, retained.length, 0)).toBe(expected.byteLength);
          expect(retained).toEqual(expected);
          expect(fs.fstatSync(fd).size).toBe(expected.byteLength);
          expect(fs.readdirSync("/etc").map(String)).not.toContainEqual(
            expect.stringContaining(".__signalbox_overlay_"),
          );
          expect(JSON.stringify(inventory)).toBe(snapshot);
          expect(forbidden).not.toHaveBeenCalled();
        } finally {
          fs.closeSync(fd);
        }
      },
      { uid: 0, inventory },
    );
  });

  it.each(["lower", "upper"])(
    "renames verified bytes over a %s file and hides the old name",
    async (destination) => {
      await withImageContentFixture(
        async ({ filesystem, forbidden, inventory }) => {
          const { fs } = createNodeFs(filesystem);
          const snapshot = JSON.stringify(inventory);
          const before = await fs.promises.readFile("/etc/config");
          if (typeof before === "string") throw new Error("Expected binary file bytes");
          if (destination === "upper") fs.writeFileSync("/etc/private", "old destination");
          const fd = fs.openSync("/etc/config", "r");
          try {
            fs.renameSync("/etc/config", "/etc/private");
            expect(fs.readFileSync("/etc/private")).toEqual(before);
            expect(fs.existsSync("/etc/config")).toBe(false);
            const retained = Buffer.alloc(before.byteLength);
            expect(fs.readSync(fd, retained, 0, retained.length, 0)).toBe(before.byteLength);
            expect(retained).toEqual(before);
            fs.unlinkSync("/etc/private");
            expect(fs.existsSync("/etc/private")).toBe(false);
            expect(fs.existsSync("/etc/config")).toBe(false);
            expect(JSON.stringify(inventory)).toBe(snapshot);
            expect(forbidden).not.toHaveBeenCalled();
          } finally {
            fs.closeSync(fd);
          }
        },
        { uid: 0 },
      );
    },
  );

  it("reports and counts unavailable bytes, rolls back both paths, then succeeds after verification", async () => {
    const trace = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await withImageContentFixture(
        async ({ filesystem, forbidden }) => {
          const { fs } = createNodeFs(filesystem);
          fs.writeFileSync("/destination", "keep me");
          const descriptors = [...filesystem.descriptors.entries()].length;
          for (const operation of [
            () => fs.appendFileSync("/etc/config", "append"),
            () => fs.renameSync("/etc/config", "/destination"),
          ]) {
            expect(operation).toThrow(
              expect.objectContaining({
                name: "KernelSynchronousFileBytesUnavailable",
                fatal: true,
                filesystemContext: {
                  operations: [{ operation: "readRange", path: "/etc/config" }],
                  generationState: expect.any(Object),
                },
              }),
            );
          }
          expect(trace.mock.calls.map(([event]) => event)).toEqual([
            {
              action: "computer.filesystem.sync_bytes_unavailable",
              count: 1,
              thread: { id: "image-content-public-composition" },
            },
            {
              action: "computer.filesystem.sync_bytes_unavailable",
              count: 1,
              thread: { id: "image-content-public-composition" },
            },
          ]);
          expect(fs.existsSync("/etc/config")).toBe(true);
          expect(fs.readFileSync("/destination", "utf8")).toBe("keep me");
          expect(fs.readdirSync("/etc").map(String)).not.toContainEqual(
            expect.stringContaining(".__signalbox_overlay_"),
          );
          expect([...filesystem.descriptors.entries()]).toHaveLength(descriptors);
          const before = await fs.promises.readFile("/etc/config");
          if (typeof before === "string") throw new Error("Expected binary file bytes");
          fs.appendFileSync("/etc/config", "append");
          expect(fs.readFileSync("/etc/config")).toEqual(
            Buffer.concat([before, Buffer.from("append")]),
          );
          expect(forbidden).not.toHaveBeenCalled();
        },
        { uid: 0 },
      );
    } finally {
      trace.mockRestore();
    }
  });

  it.each(["dirty", "unknown", "different-image"])(
    "refuses a verified capture when the current generation is %s",
    async (kind) => {
      const trace = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      try {
        await withImageContentFixture(
          async ({ filesystem, forbidden, inventory, setState }) => {
            const { fs } = createNodeFs(filesystem);
            await fs.promises.readFile("/etc/config");
            fs.writeFileSync("/destination", "keep me");
            setState(
              kind === "dirty"
                ? { generation: 1, pristine: false, imageDigest: inventory.imageDigest }
                : kind === "unknown"
                  ? { generation: null, pristine: false }
                  : { generation: 1, pristine: true, imageDigest: `sha256:${"f".repeat(64)}` },
            );
            expect(() => fs.renameSync("/etc/config", "/destination")).toThrow(
              expect.objectContaining({ name: "KernelSynchronousFileBytesUnavailable" }),
            );
            expect(fs.existsSync("/etc/config")).toBe(true);
            expect(fs.readFileSync("/destination", "utf8")).toBe("keep me");
            expect(trace).toHaveBeenCalledTimes(1);
            expect(forbidden).not.toHaveBeenCalled();
          },
          { uid: 0 },
        );
      } finally {
        trace.mockRestore();
      }
    },
  );

  it("checks write permission before using verified image bytes", async () => {
    const trace = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await withImageContentFixture(async ({ filesystem, forbidden }) => {
        const { fs } = createNodeFs(filesystem);
        const before = await fs.promises.readFile("/etc/config");
        if (typeof before === "string") throw new Error("Expected binary file bytes");
        expect(() => fs.appendFileSync("/etc/config", "append")).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
        expect(await fs.promises.readFile("/etc/config")).toEqual(before);
        expect(trace).not.toHaveBeenCalled();
        expect(forbidden).not.toHaveBeenCalled();
      });
    } finally {
      trace.mockRestore();
    }
  });
});
