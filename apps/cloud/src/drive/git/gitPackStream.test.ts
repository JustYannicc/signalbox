// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - real git on temp dirs, memory sampled while verifying.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { makeRepo } from "../driveTesting.ts";
import type { Bytes } from "./gitObjects.ts";
import { verifyPack } from "./gitPack.ts";
import { verifyPackStream } from "./gitPackStream.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const repo = () => {
  const made = makeRepo();
  cleanups.push(made.cleanup);
  return made;
};

/** `bytes` as a stream of small chunks, as R2 sends a body. */
const streamOf = (bytes: Bytes, chunk = 64 * 1024) =>
  new ReadableStream<Bytes>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunk) {
        controller.enqueue(bytes.slice(at, at + chunk));
      }
      controller.close();
    },
  });

const verify = (pack: Bytes, idx: Bytes) =>
  verifyPackStream({ stream: streamOf(pack), size: pack.length, idx });

/** The same objects, structure and references, whichever way it was read. */
const summary = (verified: Awaited<ReturnType<typeof verifyPack>>) => ({
  name: verified.name,
  objects: verified.objects
    .map(
      (object) => `${object.oid} ${object.type} ${object.offset} ${object.length} ${object.size}`,
    )
    .toSorted(),
  structure: [...verified.structure.keys()].toSorted(),
  external: [...verified.external].toSorted(),
});

describe("verifyPackStream", () => {
  it("reads a pack the way verifyPack does, deltas included", async () => {
    const source = repo();
    source.write("a.txt", "one\n".repeat(500));
    const first = source.commit("first");
    source.write("a.txt", `${"one\n".repeat(500)}two\n`);
    source.write("dir/b.txt", "b\n");
    const second = source.commit("second");
    const { pack, idx } = source.pack([second]);
    expect(summary(await verify(pack, idx))).toEqual(summary(await verifyPack(pack, idx)));
    // Against what the drive already holds: the commit and folders it names stay outside.
    const thin = source.pack([second], [first]);
    expect(summary(await verify(thin.pack, thin.idx))).toEqual(
      summary(await verifyPack(thin.pack, thin.idx)),
    );
  });

  it("hashes a file too big to hold as it inflates", async () => {
    const source = repo();
    const big = NodeCrypto.randomBytes(20 * 1024 * 1024);
    NodeFS.writeFileSync(NodePath.join(source.dir, "big.bin"), big);
    const head = source.commit("big");
    const { pack, idx } = source.pack([head]);
    const verified = await verify(pack, idx);
    const oid = source.git(["rev-parse", `${head}:big.bin`]);
    expect(verified.objects.find((object) => object.oid === oid)).toMatchObject({
      type: "blob",
      size: big.length,
    });
    // Cut off inside that file: refused, rather than left waiting on the inflater.
    await expect(
      verifyPackStream({
        stream: streamOf(pack.subarray(0, pack.length / 2)),
        size: pack.length,
        idx,
      }),
    ).rejects.toThrow(/ends early|incorrect|unexpected|invalid/i);
  });

  it("refuses an index that names an object wrongly, and a pack cut short", async () => {
    const source = repo();
    source.write("a.txt", "a\n");
    source.write("b.txt", "b\n");
    const { pack, idx } = source.pack([source.commit("two files")]);
    // Swap two objects' offsets, then reseal the index: each id now names the other's content.
    const tampered = idx.slice();
    const count = new DataView(idx.buffer).getUint32(8 + 255 * 4);
    const offsets = 8 + 1024 + count * 24;
    const a = tampered.slice(offsets, offsets + 4);
    tampered.copyWithin(offsets, offsets + 4, offsets + 8);
    tampered.set(a, offsets + 4);
    tampered.set(
      NodeCrypto.createHash("sha1")
        .update(tampered.subarray(0, tampered.length - 20))
        .digest(),
      tampered.length - 20,
    );
    await expect(verify(pack, tampered)).rejects.toThrow(/does not match|out of range/);
    await expect(
      verifyPackStream({
        stream: streamOf(pack.subarray(0, pack.length - 30)),
        size: pack.length,
        idx,
      }),
    ).rejects.toThrow(/ends early/);
  });

  // `SIGNALBOX_BIG_PACK_MB=300 vp test run …` checks a pack that size, reporting peak memory.
  const bigMb = Number(process.env.SIGNALBOX_BIG_PACK_MB ?? 0);
  it.skipIf(bigMb === 0)(
    "verifies a big pack holding little of it at once",
    async () => {
      const source = repo();
      for (let i = 0; i < bigMb / 25; i++) {
        NodeFS.writeFileSync(
          NodePath.join(source.dir, `part-${i}.bin`),
          NodeCrypto.randomBytes(25 * 1024 * 1024),
        );
      }
      const head = source.commit("big");
      const out = NodeFS.mkdtempSync(NodePath.join(source.dir, "..", "big-pack-"));
      cleanups.push(() => NodeFS.rmSync(out, { recursive: true, force: true }));
      const name = source.git(["pack-objects", "--revs", NodePath.join(out, "pack")], `${head}\n`);
      const file = NodePath.join(out, `pack-${name}.pack`);
      const idx = new Uint8Array(NodeFS.readFileSync(NodePath.join(out, `pack-${name}.idx`)));
      const before = process.memoryUsage();
      const baseline = before.heapUsed + before.arrayBuffers;
      let peak = 0;
      const sample = setInterval(() => {
        const memory = process.memoryUsage();
        peak = Math.max(peak, memory.heapUsed + memory.arrayBuffers);
      }, 5);
      const verified = await verifyPackStream({
        stream: NodeStream.Readable.toWeb(NodeFS.createReadStream(file)) as ReadableStream<Bytes>,
        size: NodeFS.statSync(file).size,
        idx,
      });
      clearInterval(sample);
      NodeFS.writeFileSync(
        "/tmp/signalbox-big-pack.json",
        JSON.stringify({
          packBytes: NodeFS.statSync(file).size,
          baselineBytes: baseline,
          peakBytes: peak,
          verifyBytes: peak - baseline,
        }),
      );
      expect(verified.name).toBe(name);
      // What verifying adds on top of the test's own memory: far below an isolate's 128 MB.
      expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
    },
    600_000,
  );
});
