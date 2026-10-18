// @effect-diagnostics globalDate:off globalFetch:off - Native HTTP interception verifies the existing storage signature without buffering the upload.
import { MAX_DIRECT_PACK_BYTES } from "@signalbox/runner-protocol/DriveProtocol";

import { drivePackPrefix } from "../drive/DrivePacks.ts";
import {
  directStorageSettings,
  DIRECT_UPLOAD_URL_SECONDS,
  MAX_DIRECT_INDEX_BYTES,
  type DirectUploadsEnv,
} from "../drive/directStorage.ts";

const queryKeys = new Set([
  "X-Amz-Expires",
  "X-Amz-Date",
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-SignedHeaders",
  "X-Amz-Signature",
]);

const refused = () =>
  new Response("Signalbox refused this platform upload.\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-signalbox-refused": "secret" },
  });

/** A presigned PUT is a capability for one private drive object, never a storage-host allowlist. */
export const makePlatformUpload = (input: {
  readonly env: DirectUploadsEnv & { readonly DRIVE_PACKS_PREFIX?: string };
  readonly drive: () => Promise<string | null>;
  readonly now?: () => number;
  readonly send?: (request: Request) => Promise<Response>;
}) => {
  const storage = directStorageSettings(input.env);
  const prefix = drivePackPrefix(input.env.DRIVE_PACKS_PREFIX);
  const now = input.now ?? Date.now;
  const send = input.send ?? ((request: Request) => fetch(request));
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    // Most egress never reaches a thread object through this path.
    if (storage === null || !url.searchParams.has("X-Amz-Signature")) return null;
    const endpoint = new URL(storage.endpoint);
    if (
      url.protocol !== "https:" ||
      url.origin !== endpoint.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    )
      return null;
    if (!url.pathname.startsWith(storage.path(`incoming/${prefix}`))) return null;
    try {
      if (request.method !== "PUT") return refused();
      if (
        url.searchParams.size !== queryKeys.size ||
        [...url.searchParams.keys()].some((key) => !queryKeys.has(key)) ||
        [...queryKeys].some((key) => url.searchParams.getAll(key).length !== 1)
      )
        return refused();
      if (
        url.searchParams.get("X-Amz-SignedHeaders") !== "content-length;host" ||
        url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256"
      )
        return refused();
      const date = url.searchParams.get("X-Amz-Date") ?? "";
      if (!/^\d{8}T\d{6}Z$/.test(date)) return refused();
      const issued = Date.parse(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      );
      const expires = Number(url.searchParams.get("X-Amz-Expires"));
      const time = now();
      if (
        !Number.isFinite(issued) ||
        !Number.isSafeInteger(expires) ||
        expires <= 0 ||
        expires > DIRECT_UPLOAD_URL_SECONDS ||
        issued > time ||
        time >= issued + expires * 1000
      )
        return refused();
      const drive = await input.drive();
      if (drive === null) return refused();
      const target = storage.path(`incoming/${prefix}${drive}/`);
      if (!url.pathname.startsWith(target)) return refused();
      const file =
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pack|idx)$/.exec(
          url.pathname.slice(target.length),
        );
      if (file === null) return refused();
      const rawLength = request.headers.get("content-length") ?? "";
      const length = Number(rawLength);
      const limit = file[2] === "pack" ? MAX_DIRECT_PACK_BYTES : MAX_DIRECT_INDEX_BYTES;
      if (
        !/^\d+$/.test(rawLength) ||
        !Number.isSafeInteger(length) ||
        length <= 0 ||
        length > limit ||
        request.body === null
      )
        return refused();
      const signature = url.searchParams.get("X-Amz-Signature") ?? "";
      if (!/^[0-9a-f]{64}$/.test(signature)) return refused();
      const unsigned = new URL(url);
      unsigned.searchParams.delete("X-Amz-Signature");
      const signed = await storage.s3.sign(unsigned, {
        method: "PUT",
        headers: { "content-length": rawLength },
        aws: { signQuery: true, allHeaders: true, datetime: date },
      });
      const expected = new URL(signed.url);
      if (
        [...queryKeys].some((key) => url.searchParams.get(key) !== expected.searchParams.get(key))
      )
        return refused();
      try {
        const response = await send(
          new Request(request.url, {
            method: "PUT",
            headers: { "content-length": rawLength, "content-type": "application/octet-stream" },
            body: request.body,
            redirect: "manual",
            duplex: "half",
          } as RequestInit),
        );
        // The Runner needs only the status. Never echo signed URLs or upload bytes.
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) return refused();
        return new Response(null, { status: response.status });
      } catch {
        // Preserve the Runner's retry for transient storage failures, without the native error URL.
        return new Response("Signalbox could not reach drive storage.\n", { status: 502 });
      }
    } catch {
      // Native errors may quote the signed URL. Do not log or return them.
      return refused();
    }
  };
};
