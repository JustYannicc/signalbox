import {
  DRIVE_PATHS,
  type DriveAccess,
  type DriveState,
  driveJson,
  MAX_PACK_BYTES,
  PACK_INDEX_LENGTH_HEADER,
  PACKS_AFTER_HEADER,
  type PackUploadResult,
  type ReconcileRequest,
  type RefUpdate,
  type RefWriteResult,
  REMOTE_HEAD_HEADER,
} from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * A thread's machine talking to its drive on the cloud (`DriveProtocol.ts`).
 * Every call carries the turn's drive token. Network failures, 5xx, 409 and
 * 429 are retried a few times with backoff; any other non-2xx fails at once.
 * A ref write that loses a race is not an error: it answers `conflict`.
 */

export class DriveClientError extends Schema.TaggedError<DriveClientError>()("DriveClientError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  retryable: Schema.Boolean,
}) {}

export interface DriveClient {
  /** Records that this machine has every pack up to `seq`; later states list only newer ones. */
  readonly havePacksThrough: (seq: number) => void;
  readonly open: Effect.Effect<DriveState, DriveClientError>;
  /** The drive as it is, without opening it for this thread. */
  readonly state: Effect.Effect<DriveState, DriveClientError>;
  /** Puts `pack-<name>.pack` and `.idx` into `packDir`; idx last, so git never sees half a pack. */
  readonly downloadPack: (name: string, packDir: string) => Effect.Effect<void, DriveClientError>;
  /** `remoteHead`: the pack holds the remote's head, whose parents stay on the remote. */
  readonly uploadPack: (
    idx: Uint8Array,
    pack: Uint8Array,
    options?: { readonly remoteHead?: string },
  ) => Effect.Effect<typeof PackUploadResult.Type, DriveClientError>;
  readonly updateRefs: (
    updates: ReadonlyArray<RefUpdate>,
  ) => Effect.Effect<RefWriteResult, DriveClientError>;
  readonly reconcile: (
    request: typeof ReconcileRequest.Type,
  ) => Effect.Effect<RefWriteResult, DriveClientError>;
  readonly mirror: (
    request: typeof ReconcileRequest.Type,
  ) => Effect.Effect<RefWriteResult, DriveClientError>;
  /** Where git fetches the drive's remote through the cloud. */
  readonly remoteUrl: string;
}

const RETRY = {
  times: 4,
  schedule: Schedule.exponential("250 millis"),
  while: (error: DriveClientError) => error.retryable,
};

const isRetryableStatus = (status: number) => status >= 500 || status === 409 || status === 429;

/** Decodes a JSON answer, turning a malformed one into a (non-retryable) client error. */
const decodeWith =
  <A>(decode: (text: string) => A, what: string) =>
  (text: string) =>
    Effect.try({
      try: () => decode(text),
      catch: () =>
        new DriveClientError({ message: `The drive sent a malformed ${what}.`, retryable: false }),
    });

/** Needs an `HttpClient` (`FetchHttpClient.layer` will do), a `FileSystem` and a `Path`. */
export const makeDriveClient = Effect.fn("makeDriveClient")(function* (input: {
  readonly cloudUrl: string;
  readonly access: DriveAccess;
}) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const origin = input.cloudUrl.replace(/\/+$/, "");
  let packsAfter = 0;

  /** Sends `request`, answering the 2xx body's bytes. */
  const send = (request: HttpClientRequest.HttpClientRequest, label: string) =>
    Effect.gen(function* () {
      const response = yield* http
        .execute(
          request.pipe(
            HttpClientRequest.bearerToken(input.access.token),
            HttpClientRequest.setHeader(PACKS_AFTER_HEADER, String(packsAfter)),
          ),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new DriveClientError({ message: `${label}: ${error.message}`, retryable: true }),
          ),
        );
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* new DriveClientError({
          message: `${label} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
          status: response.status,
          retryable: isRetryableStatus(response.status),
        });
      }
      const body = yield* response.arrayBuffer.pipe(
        Effect.mapError(
          (error) =>
            new DriveClientError({ message: `${label}: ${error.message}`, retryable: true }),
        ),
      );
      return new Uint8Array(body);
    }).pipe(Effect.retry(RETRY));

  const text = (request: HttpClientRequest.HttpClientRequest, label: string) =>
    send(request, label).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));

  const postJson = (url: string, body: string, label: string) =>
    text(
      HttpClientRequest.post(`${origin}${url}`).pipe(
        HttpClientRequest.bodyText(body, "application/json"),
      ),
      label,
    );

  const writeRefs = (url: string, body: string, label: string) =>
    postJson(url, body, label).pipe(
      Effect.flatMap(decodeWith(driveJson.refWrite.decode, "ref answer")),
    );

  const fileError = (label: string) => (error: { readonly message: string }) =>
    new DriveClientError({ message: `${label}: ${error.message}`, retryable: false });

  const downloadPack: DriveClient["downloadPack"] = (name, packDir) =>
    Effect.gen(function* () {
      const target = (ext: string) => path.join(packDir, `pack-${name}.${ext}`);
      const present = yield* Effect.all([fs.exists(target("pack")), fs.exists(target("idx"))]).pipe(
        Effect.mapError(fileError("checking a pack")),
      );
      if (present[0] && present[1]) return;
      yield* fs
        .makeDirectory(packDir, { recursive: true })
        .pipe(Effect.mapError(fileError("pack dir")));
      for (const ext of ["pack", "idx"]) {
        const bytes = yield* send(
          HttpClientRequest.get(`${origin}${DRIVE_PATHS.packs}/${name}.${ext}`),
          `downloading pack ${name}.${ext}`,
        );
        const staged = `${target(ext)}.download`;
        yield* fs.writeFile(staged, bytes).pipe(Effect.mapError(fileError("writing a pack")));
        yield* fs.rename(staged, target(ext)).pipe(Effect.mapError(fileError("writing a pack")));
      }
    });

  const uploadPack: DriveClient["uploadPack"] = (idx, pack, options = {}) =>
    Effect.gen(function* () {
      if (pack.byteLength > MAX_PACK_BYTES) {
        return yield* new DriveClientError({
          message: `A pack of ${pack.byteLength} bytes is bigger than the drive takes (${MAX_PACK_BYTES}).`,
          retryable: false,
        });
      }
      const body = new Uint8Array(idx.byteLength + pack.byteLength);
      body.set(idx, 0);
      body.set(pack, idx.byteLength);
      const answer = yield* text(
        HttpClientRequest.post(`${origin}${DRIVE_PATHS.packs}`).pipe(
          HttpClientRequest.setHeader(PACK_INDEX_LENGTH_HEADER, String(idx.byteLength)),
          options.remoteHead === undefined
            ? (request) => request
            : HttpClientRequest.setHeader(REMOTE_HEAD_HEADER, options.remoteHead),
          HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
        ),
        "uploading a pack",
      );
      return yield* decodeWith(driveJson.packUpload.decode, "pack answer")(answer);
    });

  return {
    havePacksThrough: (seq) => {
      packsAfter = Math.max(packsAfter, seq);
    },
    open: postJson(DRIVE_PATHS.open, "{}", "opening the drive").pipe(
      Effect.flatMap(decodeWith(driveJson.state.decode, "drive state")),
    ),
    state: postJson(DRIVE_PATHS.state, "{}", "reading the drive").pipe(
      Effect.flatMap(decodeWith(driveJson.state.decode, "drive state")),
    ),
    downloadPack,
    uploadPack,
    updateRefs: (updates) =>
      writeRefs(DRIVE_PATHS.refs, driveJson.refUpdate.encode({ updates }), "moving refs"),
    reconcile: (request) =>
      writeRefs(DRIVE_PATHS.reconcile, driveJson.reconcile.encode(request), "reconciling main"),
    mirror: (request) =>
      writeRefs(DRIVE_PATHS.mirror, driveJson.mirror.encode(request), "mirroring the remote"),
    remoteUrl: `${origin}${DRIVE_PATHS.remote}`,
  } satisfies DriveClient;
});
