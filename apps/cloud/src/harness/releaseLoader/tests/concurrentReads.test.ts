import { expect, it } from "vite-plus/test";
import type { HarnessReleaseArtifactSource } from "../../../harnessReleases/HarnessReleaseArtifact.ts";
import {
  RELEASE_READ_BYTES,
  RELEASE_READ_CONCURRENCY,
  loadHarnessRelease,
} from "../../HarnessReleaseLoader.ts";
import { claudeFixture } from "./artifactFixtures.ts";

const k = RELEASE_READ_CONCURRENCY;
const asset = (bytes: Uint8Array) => ({ bytes, loader: 5, encoding: 0 });
const smallAssets = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `/extra-${i}`,
      asset(new TextEncoder().encode(`asset ${i}`)),
    ]),
  );
const isPayload = (path: string) => !path.endsWith("manifest.json");

interface HeldRead {
  readonly path: string;
  readonly batch: number;
  readonly release: (failure?: Error) => void;
  readonly finished: Promise<void>;
}

/**
 * Holds every payload read until the test ends the current batch. A batch stands for one read
 * latency, so a load takes as many latencies as it needs batches.
 */
function heldReads(source: HarnessReleaseArtifactSource) {
  const held: HeldRead[] = [];
  const started: string[] = [];
  const latencies: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let batch = 0;
  let waiter: { readonly count: number; readonly resolve: () => void } | undefined;
  const hold = async <A>(path: string, run: () => Promise<A>): Promise<A> => {
    if (!isPayload(path)) return run();
    started.push(path);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    const finished = Promise.withResolvers<void>();
    const startedIn = batch;
    const failure = await new Promise<Error | undefined>((release) => {
      held.push({ path, batch: startedIn, release, finished: finished.promise });
      if (waiter !== undefined && held.length >= waiter.count) waiter.resolve();
    });
    inFlight--;
    latencies.push(batch - startedIn);
    try {
      if (failure !== undefined) throw failure;
      return await run();
    } finally {
      finished.resolve();
    }
  };
  return {
    source: {
      read: (reference, path) => hold(path, () => source.read(reference, path)),
    } satisfies HarnessReleaseArtifactSource,
    held,
    started,
    latencies,
    maxInFlight: () => maxInFlight,
    /** Resolves once `count` reads are held at the same time. */
    until: (count: number) =>
      new Promise<void>((resolve) => {
        if (held.length >= count) resolve();
        else waiter = { count, resolve };
      }),
    /** One latency passes: every held read completes, in the given order. */
    finish: (order: "forward" | "reverse" = "forward") => {
      batch++;
      const done = held.splice(0);
      for (const read of order === "reverse" ? done.toReversed() : done) read.release();
      return done;
    },
  };
}

async function drain(
  reads: ReturnType<typeof heldReads>,
  files: number,
  order: "forward" | "reverse" = "forward",
) {
  const batches: string[][] = [];
  for (let done = 0; done < files;) {
    await reads.until(Math.min(k, files - done));
    const batch = reads.finish(order);
    batches.push(batch.map(({ path }) => path));
    done += batch.length;
  }
  return batches;
}

it("reads n release files in ceil(n/k) read latencies, not n", async () => {
  const fixture = await claudeFixture({ assets: smallAssets(40) });
  const files = [...fixture.files.keys()].filter(isPayload).length;
  const reads = heldReads(fixture.options.source);
  const loading = loadHarnessRelease({ ...fixture.options, source: reads.source });
  const batches = await drain(reads, files);
  const loaded = await loading;
  expect(files).toBeGreaterThan(5 * k);
  expect(reads.maxInFlight()).toBe(k);
  // Each read takes exactly one latency, and the load takes ceil(n/k) of them instead of n.
  expect(reads.latencies).toEqual(Array.from({ length: files }, () => 1));
  expect(batches).toHaveLength(Math.ceil(files / k));
  expect(new Set(reads.started).size).toBe(files);
  expect(loaded.payloads.size).toBeGreaterThan(40);
});

it("returns payloads in release order however the reads finish", async () => {
  const plain = await claudeFixture({ assets: smallAssets(20) });
  const expected = [...(await loadHarnessRelease(plain.options)).payloads.keys()];
  const fixture = await claudeFixture({ assets: smallAssets(20) });
  const reads = heldReads(fixture.options.source);
  const loading = loadHarnessRelease({ ...fixture.options, source: reads.source });
  await drain(reads, [...fixture.files.keys()].filter(isPayload).length, "reverse");
  expect([...(await loading).payloads.keys()]).toEqual(expected);
});

it("fails with the first read error at once and starts no further reads", async () => {
  const fixture = await claudeFixture({ assets: smallAssets(40) });
  const reads = heldReads(fixture.options.source);
  const outcome = loadHarnessRelease({ ...fixture.options, source: reads.source }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await reads.until(k);
  const [failing, ...inFlight] = reads.held.splice(0);
  failing!.release(new Error("asset read failed"));
  // The load fails while the other reads are still held.
  expect(await outcome).toMatchObject({ message: "asset read failed" });
  const startedAtFailure = reads.started.length;
  for (const read of inFlight) read.release();
  await Promise.all(inFlight.map(({ finished }) => finished));
  await new Promise((resolve) => setImmediate(resolve));
  expect(startedAtFailure).toBe(k);
  expect(reads.started).toHaveLength(startedAtFailure);
});

it("reads a file as large as the byte budget alone", async () => {
  const fixture = await claudeFixture({
    assets: { ...smallAssets(12), "/large": asset(new Uint8Array(RELEASE_READ_BYTES).fill(1)) },
  });
  const reads = heldReads(fixture.options.source);
  const loading = loadHarnessRelease({ ...fixture.options, source: reads.source });
  const large = [...fixture.files].find(([, bytes]) => bytes.length === RELEASE_READ_BYTES)![0];
  // While the large read waits for the whole budget it holds a slot, so a batch is whatever is
  // held; the large read must never be held together with another.
  const batches: string[][] = [];
  const files = [...fixture.files.keys()].filter(isPayload).length;
  for (let done = 0; done < files;) {
    await reads.until(1);
    const batch = reads.finish().map(({ path }) => path);
    batches.push(batch);
    done += batch.length;
  }
  await loading;
  expect(batches.filter((batch) => batch.includes(large))).toEqual([[large]]);
});
