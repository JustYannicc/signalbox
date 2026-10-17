import { describe, expect, it } from "vite-plus/test";

import { s3Storage } from "../../drive/directStorage.ts";
import { makePlatformUpload } from "../EgressUpload.ts";
import { serveWithFakeNetwork as serveEgress } from "../tests/egressTestKit.ts";

const DRIVE = "my/personal/upload-test";
const env = {
  DRIVE_PACKS_S3_ACCESS_KEY_ID: "throwaway-platform-key-id",
  DRIVE_PACKS_S3_SECRET_ACCESS_KEY: "throwaway-platform-signing-key",
  DRIVE_PACKS_S3_ENDPOINT: "https://storage.example.test",
  DRIVE_PACKS_BUCKET_NAME: "private-drive-packs",
};
const value = "throwaway-registered-secret";
const registration = {
  registered: 1,
  registeredRunId: "test-run",
  revision: 1,
  current: [{ name: "KEY", value }],
  values: [{ name: "KEY", value }],
};

describe("guarded platform upload capability", () => {
  it("lets the Runner's platform-issued direct binary PUT leave with secrets registered", async () => {
    const bytes = new Uint8Array([80, 65, 67, 75, 0, 255, 0]);
    const url = await s3Storage(env)!.presignPut(
      `incoming/${DRIVE}/00000000-0000-4000-8000-000000000000.pack`,
      bytes.byteLength,
    );
    let sent = false;
    const send = async (request: Request) => {
      sent = true;
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
      return new Response(null);
    };
    const response = await serveEgress(
      new Request(url, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
        },
        body: bytes,
      }),
      {
        ownHosts: new Set(["cloud.example.test", "gateway.example.test"]),
        platformUpload: makePlatformUpload({ env, drive: async () => DRIVE, send }),
        thread: {
          secrets: async () => registration,
          authorize: async () => ({ _tag: "refused", message: "not a secret send" }),
        },
        send,
      },
    );
    expect(response.status).toBe(200);
    expect(sent).toBe(true);
  });
});

it("refuses forged, expired, cross-drive and modified capabilities without forwarding any byte", async () => {
  const bytes = new Uint8Array([80, 65, 67, 75, 0, 255, 0]);
  const signer = s3Storage(env)!;
  const key = `incoming/${DRIVE}/00000000-0000-4000-8000-000000000000.pack`;
  const original = await signer.presignPut(key, bytes.byteLength);
  const otherDrive = await signer.presignPut(
    "incoming/my/personal/someone-else/00000000-0000-4000-8000-000000000000.pack",
    bytes.byteLength,
  );
  const cases = [
    { url: original, drive: null },
    { url: original, method: "POST" },
    { url: original, prefix: "pr-123/" },
    { url: original, bucket: "other-bucket" },
    { url: otherDrive },
    { url: original.replace("storage.example.test", "public-storage.example.test") },
    { url: original.replace("https:", "http:") },
    { url: original.replace(".pack?", ".idx?") },
    { url: `${original}&untrusted=1` },
    { url: `${original}&X-Amz-Signature=duplicate` },
    { url: original.replace(/X-Amz-Signature=[a-f0-9]+/, "X-Amz-Signature=" + "0".repeat(64)) },
    { url: original, length: String(bytes.byteLength + 1) },
    { url: original, expired: true },
  ];
  for (const candidate of cases) {
    let sends = 0;
    const send = async () => {
      sends++;
      return new Response(null);
    };
    const issued = new URL(original).searchParams.get("X-Amz-Date")!;
    const expiry =
      Date.parse(
        `${issued.slice(0, 4)}-${issued.slice(4, 6)}-${issued.slice(6, 8)}T${issued.slice(9, 11)}:${issued.slice(11, 13)}:${issued.slice(13, 15)}Z`,
      ) + 900_000;
    const response = await serveEgress(
      new Request(candidate.url, {
        method: candidate.method ?? "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": candidate.length ?? String(bytes.byteLength),
        },
        body: bytes,
      }),
      {
        ownHosts: new Set(),
        platformUpload: makePlatformUpload({
          env: {
            ...env,
            ...(candidate.bucket ? { DRIVE_PACKS_BUCKET_NAME: candidate.bucket } : {}),
            ...(candidate.prefix ? { DRIVE_PACKS_PREFIX: candidate.prefix } : {}),
          },
          drive: async () => ("drive" in candidate ? candidate.drive : DRIVE),
          ...(candidate.expired ? { now: () => expiry } : {}),
          send,
        }),
        thread: { secrets: async () => registration, authorize: async () => ({ _tag: "allowed" }) },
        send,
      },
    );
    expect(response.status).toBe(403);
    expect(sends).toBe(0);
  }
});

it("streams a large signed pack and strips caller headers and storage echoes", async () => {
  const length = 2 * 1024 ** 3;
  const url = await s3Storage(env)!.presignPut(
    `incoming/${DRIVE}/00000000-0000-4000-8000-000000000000.pack`,
    length,
  );
  let pulls = 0;
  let sends = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: () => {
      pulls++;
    },
  });
  const request = new Request(url, {
    method: "PUT",
    headers: {
      "content-length": String(length),
      authorization: "must-stay-local",
      "x-amz-acl": "public-read",
    },
    body,
    duplex: "half",
  } as RequestInit);
  const response = await makePlatformUpload({
    env,
    drive: async () => DRIVE,
    send: async (outgoing) => {
      sends++;
      expect(outgoing.body).not.toBeNull();
      expect(outgoing.headers.get("content-length")).toBe(String(length));
      expect(outgoing.headers.get("authorization")).toBeNull();
      expect(outgoing.headers.get("x-amz-acl")).toBeNull();
      expect(outgoing.redirect).toBe("manual");
      await outgoing.body?.cancel();
      return new Response(value, { headers: { "x-echo": value } });
    },
  })(request);
  expect(response?.status).toBe(200);
  expect(await response?.text()).toBe("");
  expect(response?.headers.get("x-echo")).toBeNull();
  expect(sends).toBe(1);
  // A stream may prefetch its first chunk; validation must never drain the pack into memory.
  expect(pulls).toBeLessThanOrEqual(1);
});

it("keeps arbitrary binary HTTP and HTTPS uploads refused with the platform hook installed", async () => {
  let sends = 0;
  const send = async () => {
    sends++;
    return new Response(null);
  };
  for (const protocol of ["http", "https"]) {
    const response = await serveEgress(
      new Request(`${protocol}://arbitrary.example.test/pack`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([0, 255]),
      }),
      {
        ownHosts: new Set(),
        platformUpload: makePlatformUpload({ env, drive: async () => DRIVE, send }),
        thread: { secrets: async () => registration, authorize: async () => ({ _tag: "allowed" }) },
        send,
      },
    );
    expect(response.status).toBe(403);
  }
  expect(sends).toBe(0);
});

it("keeps retryable storage failures sanitized and never follows a storage redirect", async () => {
  const url = await s3Storage(env)!.presignPut(
    `incoming/${DRIVE}/00000000-0000-4000-8000-000000000000.pack`,
    7,
  );
  for (const send of [
    async () => {
      throw new Error(`network failed: ${url}`);
    },
    async () => new Response(url, { status: 503, headers: { "x-echo": value } }),
    async () =>
      new Response(null, { status: 307, headers: { location: "https://arbitrary.example.test" } }),
  ]) {
    const request = new Request(url, {
      method: "PUT",
      headers: { "content-length": "7" },
      body: new Uint8Array(7),
    });
    const response = await makePlatformUpload({ env, drive: async () => DRIVE, send })(request);
    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(await response?.text()).not.toContain(url);
    expect(response?.headers.get("location")).toBeNull();
    expect(response?.headers.get("x-echo")).toBeNull();
  }
});
