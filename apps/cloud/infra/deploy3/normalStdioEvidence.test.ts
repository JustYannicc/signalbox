import * as NodeAssert from "node:assert/strict";
import * as TestCase from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { controlFixture } from "./control.fixture.ts";
import { exportDeploy3Locally, verifyDeploy3LocalExport } from "./normalEvidence.ts";
import { createNativeStdioCapture, type NativeStdioChannel } from "./nativeStdio.ts";

const CHUNK_BYTES = 16_384;
const digestBytes = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function stdioExportFixture(
  input: {
    readonly omitOrdinal?: { readonly channel: NativeStdioChannel; readonly ordinal: number };
    readonly legacyPrefix?: true;
    readonly checkpointBeforeCrash?: true;
    readonly corruptCheckpoint?: true;
  } = {},
) {
  const blobs = new Map<string, Uint8Array>();
  const entries: (readonly [string, unknown])[] = [];
  let sequence = 0;
  const addBlob = async (id: string, bytes: Uint8Array) => {
    const ref = { id, bytes: bytes.byteLength, sha256: await digestBytes(bytes) };
    blobs.set(id, bytes);
    entries.push([`blob/${id}/ref`, ref]);
    return ref;
  };
  const append = async (kind: string, payload: unknown) => {
    sequence += 1;
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const ref = await addBlob(`journal-${sequence}`, bytes);
    const padded = String(sequence).padStart(10, "0");
    entries.push([`journal/record/${padded}`, { sequence, kind, payload: ref }]);
    entries.push([`journal/reservation/${padded}`, { sequence, kind, payloadHash: ref.sha256 }]);
  };

  const incarnation = "stdio-export-fixture";
  const stdout = Uint8Array.from({ length: 50_003 }, (_, index) => (index * 17) % 256);
  const stderr = Uint8Array.from({ length: 35_101 }, (_, index) => (index * 29) % 256);
  const stdin = Uint8Array.from({ length: 20_033 }, (_, index) => (index * 11) % 256);
  const observed = new Map<NativeStdioChannel, Uint8Array>([
    ["native-stdin", stdin],
    ["native-stdout", stdout],
    ["native-stderr", stderr],
  ]);
  const chunks: { readonly channel: NativeStdioChannel; readonly bytes: Uint8Array }[] = [];
  let summary: unknown;
  let summaryKind: string;
  if (input.legacyPrefix) {
    const streams = Object.fromEntries(
      [...observed].map(([channel, bytes]) => {
        const publishedBytes = Math.min(CHUNK_BYTES, bytes.byteLength);
        const captured = bytes.slice(0, publishedBytes);
        if (captured.byteLength > 0) chunks.push({ channel, bytes: captured });
        return [
          channel,
          {
            observation: channel === "native-stdin" ? "consumed" : "accepted",
            observedBytes: bytes.byteLength,
            retainedBytes: publishedBytes,
            publishedBytes,
            truncated: bytes.byteLength > CHUNK_BYTES,
          },
        ];
      }),
    );
    summary = {
      prefixLimitBytes: CHUNK_BYTES,
      incarnation,
      reason: "request-settled",
      streams,
    };
    summaryKind = "native-stdio-prefix";
  } else {
    const capture = createNativeStdioCapture();
    const enqueue = (channel: NativeStdioChannel, bytes: Uint8Array) => {
      chunks.push({ channel, bytes });
      return true;
    };
    if (input.checkpointBeforeCrash) {
      const checkpoint = capture.drain();
      if (input.corruptCheckpoint) checkpoint.streams["native-stdout"].acceptedBytes = 1;
      await append("native-stdio-streams", { ...checkpoint, incarnation, reason: "checkpoint" });
    }
    capture.write("native-stdout", stdout, enqueue);
    capture.write("native-stderr", stderr, enqueue);
    capture.write("native-stdin", stdin, enqueue);
    summary = {
      ...capture.drain(),
      incarnation,
      reason: "request-settled",
    };
    summaryKind = "native-stdio-streams";
  }

  const ordinals = new Map<NativeStdioChannel, number>();
  for (const chunk of chunks) {
    const ordinal = (ordinals.get(chunk.channel) ?? 0) + 1;
    ordinals.set(chunk.channel, ordinal);
    if (input.omitOrdinal?.channel === chunk.channel && input.omitOrdinal.ordinal === ordinal) {
      continue;
    }
    const payload = await addBlob(`${chunk.channel}-${incarnation}-${ordinal}`, chunk.bytes);
    await append(chunk.channel, { incarnation, ordinal, payload });
  }
  if (!input.checkpointBeforeCrash) await append(summaryKind, summary);
  const sortedEntries = entries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const fetchImpl: typeof fetch = async (request, init) => {
    const url = String(request);
    if (url.includes("/export/page")) return Response.json({ entries: sortedEntries, next: null });
    const ref = JSON.parse(String(init?.body)) as { readonly id: string };
    const bytes = blobs.get(ref.id);
    return bytes
      ? new Response(new Uint8Array(bytes).buffer)
      : new Response("missing", { status: 404 });
  };
  return { fetchImpl, stdout, stderr, stdin };
}

TestCase.test(
  "normal export assembles complete stdout, stderr and stdin evidence files",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy3-stdio-"));
    try {
      const fixture = controlFixture();
      const state = (await fixture.api().read()).controls[0]!;
      const source = await stdioExportFixture();
      const directory = NodePath.join(root, "export");
      const exported = await exportDeploy3Locally({
        origin: "https://qualifier.example",
        qualifierRunId: "source-run",
        registration: state.registration,
        directory,
        fetchImpl: source.fetchImpl,
      });
      const expected = new Map([
        ["native-stdout", source.stdout],
        ["native-stderr", source.stderr],
        ["native-stdin", source.stdin],
      ] as const);
      for (const [channel, bytes] of expected) {
        const stream = exported.nativeStdio.find((item) => item.channel === channel);
        NodeAssert.ok(stream?.complete);
        NodeAssert.deepEqual(stream?.evidenceRef, {
          path: `${channel}.bin`,
          bytes: bytes.byteLength,
          sha256: await digestBytes(bytes),
        });
        NodeAssert.deepEqual(
          new Uint8Array(await NodeFSP.readFile(NodePath.join(directory, `${channel}.bin`))),
          bytes,
        );
      }

      const stdout = exported.nativeStdio.find((item) => item.channel === "native-stdout")!;
      await NodeFSP.writeFile(NodePath.join(directory, stdout.evidenceRef.path), "corrupt");
      await NodeAssert.rejects(
        verifyDeploy3LocalExport({ directory, registration: state.registration }),
        /Local native stdio stream differs from its persisted chunks/,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

TestCase.test("normal export refuses a raw stdio ordinal gap", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy3-stdio-gap-"));
  try {
    const fixture = controlFixture();
    const state = (await fixture.api().read()).controls[0]!;
    const source = await stdioExportFixture({
      omitOrdinal: { channel: "native-stdout", ordinal: 1 },
    });
    await NodeAssert.rejects(
      exportDeploy3Locally({
        origin: "https://qualifier.example",
        qualifierRunId: "source-run",
        registration: state.registration,
        directory: NodePath.join(root, "export"),
        fetchImpl: source.fetchImpl,
      }),
      /missing or reordered ordinal/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

TestCase.test("legacy 16 KiB prefix exports retain an explicit incomplete reference", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy3-stdio-legacy-"));
  try {
    const fixture = controlFixture();
    const state = (await fixture.api().read()).controls[0]!;
    const source = await stdioExportFixture({ legacyPrefix: true });
    const directory = NodePath.join(root, "export");
    const exported = await exportDeploy3Locally({
      origin: "https://qualifier.example",
      qualifierRunId: "source-run",
      registration: state.registration,
      directory,
      fetchImpl: source.fetchImpl,
    });
    const stdout = exported.nativeStdio.find((item) => item.channel === "native-stdout")!;
    NodeAssert.deepEqual(stdout, {
      incarnation: "stdio-export-fixture",
      channel: "native-stdout",
      evidenceRef: {
        path: "native-stdout.bin",
        bytes: CHUNK_BYTES,
        sha256: await digestBytes(source.stdout.slice(0, CHUNK_BYTES)),
      },
      complete: false,
      observedBytes: source.stdout.byteLength,
      chunkCount: 1,
      legacy: "prefix",
      incompleteReason: "legacy-16KiB-prefix",
    });
    await NodeAssert.rejects(
      verifyDeploy3LocalExport({ directory, registration: state.registration }),
      /explicitly incomplete/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

TestCase.test("v1 local exports remain verifiable without claiming assembled stdio", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy3-stdio-v1-"));
  try {
    const fixture = controlFixture();
    const state = (await fixture.api().read()).controls[0]!;
    const source = await stdioExportFixture({ legacyPrefix: true });
    const directory = NodePath.join(root, "export");
    await exportDeploy3Locally({
      origin: "https://qualifier.example",
      qualifierRunId: "source-run",
      registration: state.registration,
      directory,
      fetchImpl: source.fetchImpl,
    });
    const manifestPath = NodePath.join(directory, "manifest.json");
    const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
    delete manifest.nativeStdio;
    manifest.schema = "sb1070/deploy3-local-export/v1";
    await NodeFSP.writeFile(manifestPath, JSON.stringify(manifest));
    for (const channel of ["native-stdin", "native-stdout", "native-stderr"])
      await NodeFSP.rm(NodePath.join(directory, `${channel}.bin`));

    const verified = await verifyDeploy3LocalExport({
      directory,
      registration: state.registration,
    });
    NodeAssert.deepEqual(verified.nativeStdio, []);
    NodeAssert.equal(verified.stdioStatus, "legacy-v1-prefix-incomplete-unassembled");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

TestCase.test(
  "normal export retains all raw bytes after a checkpoint followed by a killed turn",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy3-stdio-crash-"));
    try {
      const state = (await controlFixture().api().read()).controls[0]!;
      const source = await stdioExportFixture({ checkpointBeforeCrash: true });
      const directory = NodePath.join(root, "export");
      const exported = await exportDeploy3Locally({
        origin: "https://qualifier.example",
        qualifierRunId: "source-run",
        registration: state.registration,
        directory,
        fetchImpl: source.fetchImpl,
      });
      for (const [channel, bytes] of [
        ["native-stdin", source.stdin],
        ["native-stdout", source.stdout],
        ["native-stderr", source.stderr],
      ] as const) {
        const stream = exported.nativeStdio.find((item) => item.channel === channel)!;
        NodeAssert.equal(stream.complete, false);
        NodeAssert.equal(stream.observedBytes, null);
        NodeAssert.equal(stream.incompleteReason, "final-summary-unavailable");
        NodeAssert.equal(stream.evidenceRef.bytes, bytes.byteLength);
        NodeAssert.deepEqual(
          new Uint8Array(await NodeFSP.readFile(NodePath.join(directory, stream.evidenceRef.path))),
          bytes,
        );
      }
      NodeAssert.ok(await NodeFSP.stat(NodePath.join(directory, "manifest.json")));
      await NodeAssert.rejects(
        verifyDeploy3LocalExport({ directory, registration: state.registration }),
        /explicitly incomplete/,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

TestCase.test("a later raw chunk does not excuse an invalid checkpoint summary", async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "deploy3-stdio-corrupt-checkpoint-"),
  );
  try {
    const state = (await controlFixture().api().read()).controls[0]!;
    const source = await stdioExportFixture({
      checkpointBeforeCrash: true,
      corruptCheckpoint: true,
    });
    await NodeAssert.rejects(
      exportDeploy3Locally({
        origin: "https://qualifier.example",
        qualifierRunId: "source-run",
        registration: state.registration,
        directory: NodePath.join(root, "export"),
        fetchImpl: source.fetchImpl,
      }),
      /summary differs from its chunks/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
