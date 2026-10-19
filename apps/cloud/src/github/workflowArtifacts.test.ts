import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as Platform from "../platform.ts";
import { zipOf } from "./actionsTesting.ts";
import { makeGitHubApi, type GitHubApi } from "./GitHubApi.ts";
import {
  makeGitHubOperationJournal,
  type GitHubOperationJournal,
} from "./githubOperationJournal.ts";
import {
  makeWorkflowApi,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_ARTIFACT_ENTRY_BYTES,
} from "./workflowApi.ts";

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
}

const endpoints = { web: "https://github.com", api: "https://api.github.test" };
const sha = "a".repeat(40);
const archiveRun = {
  id: 42,
  html_url: "https://github.com/acme/app/actions/runs/42",
  path: ".github/workflows/proof.yml@refs/heads/main",
  head_sha: sha,
  display_title: "Proof run",
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
};
const artifactInput = {
  workflowFile: "proof.yml",
  runId: "42",
  headSha: sha,
  artifactName: "proof",
  entryPath: "result.json",
} as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const put16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
const put32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);

const join = (...parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
};

const storedZip = (entries: ReadonlyArray<{ readonly name: string; readonly text: string }>) => {
  const encoder = new TextEncoder();
  const localParts: Array<Uint8Array> = [];
  const centralParts: Array<Uint8Array> = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    put32(localView, 0, 0x04034b50);
    put16(localView, 4, 20);
    put16(localView, 6, 0);
    put16(localView, 8, 0);
    put32(localView, 14, 0);
    put32(localView, 18, data.byteLength);
    put32(localView, 22, data.byteLength);
    put16(localView, 26, name.byteLength);
    put16(localView, 28, 0);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    put32(centralView, 0, 0x02014b50);
    put16(centralView, 4, 20);
    put16(centralView, 6, 20);
    put16(centralView, 8, 0);
    put16(centralView, 10, 0);
    put32(centralView, 16, 0);
    put32(centralView, 20, data.byteLength);
    put32(centralView, 24, data.byteLength);
    put16(centralView, 28, name.byteLength);
    put16(centralView, 30, 0);
    put16(centralView, 32, 0);
    put32(centralView, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }

  const directory = join(...centralParts);
  const localEntries = join(...localParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  put32(endView, 0, 0x06054b50);
  put16(endView, 8, entries.length);
  put16(endView, 10, entries.length);
  put32(endView, 12, directory.byteLength);
  put32(endView, 16, localEntries.byteLength);
  return join(localEntries, directory, end);
};

const sha256 = async (bytes: Uint8Array) => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const fixture = (respond: (request: SentRequest) => Response) => {
  const requests: Array<SentRequest> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const sent = { method: request.method, path: url.pathname, query: url.searchParams };
      requests.push(sent);
      return HttpClientResponse.fromWeb(request, respond(sent));
    }),
  );
  return { requests, api: makeGitHubApi(client, endpoints) };
};

const dependencies = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Platform.layerCrypto,
);

const workflowFor = (api: GitHubApi, journal: GitHubOperationJournal) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return makeWorkflowApi(api, journal, crypto);
  });

it.effect("checks GitHub's archive digest and returns the exact bounded UTF-8 entry", () => {
  const archive = storedZip([{ name: "result.json", text: '{"ok":true}' }]);
  let digest = "";
  const artifact = {
    id: 52,
    name: "proof",
    expired: false,
    size_in_bytes: archive.byteLength,
    digest: "",
  };
  const { api } = fixture(({ method, path }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42")) return json(archiveRun);
    if (method === "GET" && path.endsWith("/actions/runs/42/artifacts"))
      return json({ artifacts: [{ ...artifact, digest: "sha256:" + digest }] });
    if (method === "GET" && path.endsWith("/actions/artifacts/52/zip"))
      return new Response(archive);
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    digest = yield* Effect.promise(() => sha256(archive));
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const result = yield* workflow.workflowArtifact("token", "acme/app", artifactInput);

    expect(result).toMatchObject({
      run: { runId: "42", headSha: sha },
      artifact: {
        id: "52",
        name: "proof",
        digest: "sha256:" + digest,
        entryPath: "result.json",
        bytes: 11,
      },
      text: '{"ok":true}',
    });
    expect(result?.artifact.sha256).toBe(
      yield* Effect.promise(() => sha256(new TextEncoder().encode('{"ok":true}'))),
    );
  }).pipe(Effect.provide(dependencies));
});

it.effect("rejects a mismatched stored ZIP entry before copying its payload", () => {
  const payloadBytes = 9 * 1024 * 1024;
  const nameBytes = new TextEncoder().encode("result.json");
  const payloadStart = 30 + nameBytes.byteLength;
  let payloadCopies = 0;
  class CopyCountingPayload extends Uint8Array {
    override slice(begin?: number, end?: number) {
      payloadCopies += 1;
      return super.slice(begin, end);
    }
  }
  class CopyCountingArchive extends Uint8Array {
    override subarray(begin?: number, end?: number) {
      const view = super.subarray(begin, end);
      if (
        view.byteLength === payloadBytes &&
        view.byteOffset === payloadStart &&
        view.buffer instanceof ArrayBuffer
      )
        return new CopyCountingPayload(view.buffer, view.byteOffset, view.byteLength);
      return view;
    }
  }

  const storedArchive = storedZip([{ name: "result.json", text: "x".repeat(payloadBytes) }]);
  const directoryAt = storedArchive.byteLength - 22 - 46 - nameBytes.byteLength;
  put32(new DataView(storedArchive.buffer), directoryAt + 24, 1);
  const archive = new CopyCountingArchive(
    storedArchive.buffer,
    storedArchive.byteOffset,
    storedArchive.byteLength,
  );
  let digest = "";
  let downloaded = false;
  const { api: restApi } = fixture(({ method, path }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42")) return json(archiveRun);
    if (method === "GET" && path.endsWith("/actions/runs/42/artifacts"))
      return json({
        artifacts: [
          {
            id: 52,
            name: "proof",
            expired: false,
            size_in_bytes: archive.byteLength,
            digest: "sha256:" + digest,
          },
        ],
      });
    throw new Error("Unexpected " + method + " " + path);
  });
  const api: GitHubApi = {
    ...restApi,
    download: () => {
      downloaded = true;
      return Effect.succeed(archive);
    },
  };

  return Effect.gen(function* () {
    digest = yield* Effect.promise(() => sha256(archive));
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const error = yield* Effect.flip(workflow.workflowArtifact("token", "acme/app", artifactInput));
    expect(error.message).toBe("Couldn't read the requested artifact ZIP entry.");
    expect(downloaded).toBe(true);
    expect(payloadCopies).toBe(0);
  }).pipe(Effect.provide(dependencies));
});

it.effect("rejects a changed archive before extracting any entry", () => {
  const original = storedZip([{ name: "result.json", text: "original" }]);
  const tampered = new Uint8Array(original);
  tampered[30] = tampered[30] === 0x78 ? 0x79 : 0x78;
  let expectedDigest = "";
  const { api } = fixture(({ method, path }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42")) return json(archiveRun);
    if (method === "GET" && path.endsWith("/actions/runs/42/artifacts"))
      return json({
        artifacts: [
          {
            id: 52,
            name: "proof",
            expired: false,
            size_in_bytes: original.byteLength,
            digest: "sha256:" + expectedDigest,
          },
        ],
      });
    if (method === "GET" && path.endsWith("/actions/artifacts/52/zip"))
      return new Response(tampered);
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    expectedDigest = yield* Effect.promise(() => sha256(original));
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const error = yield* Effect.flip(workflow.workflowArtifact("token", "acme/app", artifactInput));
    expect(error.message).toContain("failed its SHA-256 check");
  }).pipe(Effect.provide(dependencies));
});

it.effect("cancels ZIP inflation as soon as output exceeds the declared entry size", () => {
  const archive = zipOf({ "result.json": "x" });
  let digest = "";
  let emittedBytes = 0;
  let cancelled = false;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
  if (originalDescriptor === undefined) throw new Error("DecompressionStream is unavailable.");

  class OversizedDecompressionStream {
    readonly writable = new WritableStream<Uint8Array>({ write: () => undefined });
    readonly readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emittedBytes >= MAX_ARTIFACT_ENTRY_BYTES * 2) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(64 * 1024);
        emittedBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
  }

  const { api } = fixture(({ method, path }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42")) return json(archiveRun);
    if (method === "GET" && path.endsWith("/actions/runs/42/artifacts"))
      return json({
        artifacts: [
          {
            id: 52,
            name: "proof",
            expired: false,
            size_in_bytes: archive.byteLength,
            digest: "sha256:" + digest,
          },
        ],
      });
    if (method === "GET" && path.endsWith("/actions/artifacts/52/zip"))
      return new Response(archive);
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    digest = yield* Effect.promise(() => sha256(archive));
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    Object.defineProperty(globalThis, "DecompressionStream", {
      configurable: true,
      writable: true,
      value: OversizedDecompressionStream,
    });
    try {
      const error = yield* Effect.flip(
        workflow.workflowArtifact("token", "acme/app", artifactInput),
      );
      expect(error.message).toBe("Couldn't read the requested artifact ZIP entry.");
    } finally {
      Object.defineProperty(globalThis, "DecompressionStream", originalDescriptor);
    }

    expect(cancelled).toBe(true);
    expect(emittedBytes).toBeLessThan(MAX_ARTIFACT_ENTRY_BYTES);
  }).pipe(Effect.provide(dependencies));
});

it.effect("returns null for missing or expired artifacts and refuses duplicate names", () => {
  let artifacts: ReadonlyArray<Record<string, unknown>> = [];
  const { api, requests } = fixture(({ method, path }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42")) return json(archiveRun);
    if (method === "GET" && path.endsWith("/actions/runs/42/artifacts")) return json({ artifacts });
    if (method === "GET" && path.endsWith("/actions/artifacts/52/zip"))
      return new Response("should not download");
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    expect(yield* workflow.workflowArtifact("token", "acme/app", artifactInput)).toBeNull();

    const expired = {
      id: 52,
      name: "proof",
      expired: true,
      size_in_bytes: 100,
      digest: "sha256:" + "a".repeat(64),
    };
    artifacts = [expired];
    expect(yield* workflow.workflowArtifact("token", "acme/app", artifactInput)).toBeNull();

    artifacts = [
      { ...expired, expired: false },
      { ...expired, id: 53, expired: false },
    ];
    const error = yield* Effect.flip(workflow.workflowArtifact("token", "acme/app", artifactInput));
    expect(error.message).toContain("More than one artifact");
    expect(requests.some(({ path }) => path.endsWith("/zip"))).toBe(false);
  }).pipe(Effect.provide(dependencies));
});

it.effect("bounds archive size and rejects duplicate exact ZIP entries", () => {
  const archive = storedZip([
    { name: "result.json", text: "first" },
    { name: "result.json", text: "second" },
  ]);
  let digest = "";
  let declaredSize = archive.byteLength;
  const { api, requests } = fixture(({ method, path }) => {
    if (method === "GET" && path.endsWith("/actions/runs/42")) return json(archiveRun);
    if (method === "GET" && path.endsWith("/actions/runs/42/artifacts"))
      return json({
        artifacts: [
          {
            id: 52,
            name: "proof",
            expired: false,
            size_in_bytes: declaredSize,
            digest: "sha256:" + digest,
          },
        ],
      });
    if (method === "GET" && path.endsWith("/actions/artifacts/52/zip"))
      return new Response(archive);
    throw new Error("Unexpected " + method + " " + path);
  });

  return Effect.gen(function* () {
    digest = yield* Effect.promise(() => sha256(archive));
    const workflow = yield* workflowFor(api, yield* makeGitHubOperationJournal);
    const duplicate = yield* Effect.flip(
      workflow.workflowArtifact("token", "acme/app", artifactInput),
    );
    expect(duplicate.message).toBe("Couldn't read the requested artifact ZIP entry.");

    const tooLarge = yield* Effect.flip(
      workflow.workflowArtifact("token", "acme/app", {
        ...artifactInput,
        entryPath: "../outside.json",
      }),
    );
    expect(tooLarge.message).toContain("relative ZIP entry path");
    declaredSize = MAX_ARTIFACT_ARCHIVE_BYTES + 1;
    const oversized = yield* Effect.flip(
      workflow.workflowArtifact("token", "acme/app", artifactInput),
    );
    expect(oversized.message).toContain("exceeds the download size limit");
    expect(requests.filter(({ path }) => path.endsWith("/zip"))).toHaveLength(1);
  }).pipe(Effect.provide(dependencies));
});
