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
  PRIVATE_PACK_HEADER,
  REMOTE_COMMITS_HEADER,
  REMOTE_HEAD_HEADER,
  type DriveShortcut,
  shortcutPacksPath,
  shortcutRemotePath,
} from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
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

/** An upload bigger than the drive takes, said for the person whose thread it is. */
export class DriveTooLargeError extends Schema.TaggedError<DriveTooLargeError>()(
  "DriveTooLargeError",
  { message: Schema.String },
) {}

/** A save the drive won't take as it is, with what to do about it, said for the thread's person. */
export class DriveRefusedError extends Schema.TaggedError<DriveRefusedError>()(
  "DriveRefusedError",
  { message: Schema.String },
) {}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

export interface PackUploadOptions {
  readonly remoteHead?: string;
  readonly remoteCommits?: ReadonlyArray<string>;
  readonly private?: boolean;
}

export interface DriveClient {
  /** Records that this machine has every pack up to `seq`; later states list only newer ones. */
  readonly havePacksThrough: (seq: number) => void;
  readonly open: Effect.Effect<DriveState, DriveClientError>;
  /** The drive as it is, without opening it for this thread. */
  readonly state: Effect.Effect<DriveState, DriveClientError>;
  /** Puts `pack-<name>.pack` and `.idx` into `packDir`; idx last, so git never sees half a pack. */
  readonly downloadPack: (name: string, packDir: string) => Effect.Effect<void, DriveClientError>;
  /**
   * Uploads the pack and index at these paths: straight to storage when the
   * cloud offers it (#406), else in a request's body. `remoteHead`: the pack
   * holds the remote's head; `remoteCommits`: other commits it holds from the
   * remote (#394). Their parents and files stay on the remote. `private`:
   * the pack is this thread's own machine state (`PRIVATE_PACK_HEADER`).
   */
  readonly uploadPack: (
    files: { readonly idx: string; readonly pack: string },
    options?: PackUploadOptions,
  ) => Effect.Effect<typeof PackUploadResult.Type, DriveClientError | DriveTooLargeError>;
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
  /** The drive's shortcuts (#142), each target's packs listed after `have[target]`. */
  readonly shortcuts: (
    have: Readonly<Record<string, number>>,
  ) => Effect.Effect<ReadonlyArray<DriveShortcut>, DriveClientError>;
  /** Like `downloadPack`, from a shortcut target. */
  readonly downloadShortcutPack: (
    target: string,
    name: string,
    packDir: string,
  ) => Effect.Effect<void, DriveClientError>;
  /** Where git fetches a remote-backed shortcut target's remote through the cloud. */
  readonly shortcutRemoteUrl: (target: string) => string;
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

  /** Downloads `pack-<name>` from under `packsPath` into `packDir`, unless it is there. */
  const fetchPack = (packsPath: string, name: string, packDir: string) =>
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
          HttpClientRequest.get(`${origin}${packsPath}/${name}.${ext}`),
          `downloading pack ${name}.${ext}`,
        );
        const staged = `${target(ext)}.download`;
        yield* fs.writeFile(staged, bytes).pipe(Effect.mapError(fileError("writing a pack")));
        yield* fs.rename(staged, target(ext)).pipe(Effect.mapError(fileError("writing a pack")));
      }
    });

  const downloadPack: DriveClient["downloadPack"] = (name, packDir) =>
    fetchPack(DRIVE_PATHS.packs, name, packDir);

  /** Bytes in a request's body: what a cloud without direct uploads takes, up to `MAX_PACK_BYTES`. */
  const uploadInline = (
    files: { readonly idx: string; readonly pack: string },
    packSize: number,
    options: PackUploadOptions,
  ) =>
    Effect.gen(function* () {
      if (packSize > MAX_PACK_BYTES) {
        return yield* new DriveTooLargeError({
          message: `This save is ${megabytes(packSize)}, more than the ${megabytes(MAX_PACK_BYTES)} a drive takes in one upload.`,
        });
      }
      const [idx, pack] = yield* Effect.all([fs.readFile(files.idx), fs.readFile(files.pack)]).pipe(
        Effect.mapError(fileError("reading a pack")),
      );
      const body = new Uint8Array(idx.byteLength + pack.byteLength);
      body.set(idx, 0);
      body.set(pack, idx.byteLength);
      const answer = yield* text(
        HttpClientRequest.post(`${origin}${DRIVE_PATHS.packs}`).pipe(
          HttpClientRequest.setHeader(PACK_INDEX_LENGTH_HEADER, String(idx.byteLength)),
          options.remoteHead === undefined
            ? (request) => request
            : HttpClientRequest.setHeader(REMOTE_HEAD_HEADER, options.remoteHead),
          options.remoteCommits === undefined || options.remoteCommits.length === 0
            ? (request) => request
            : HttpClientRequest.setHeader(REMOTE_COMMITS_HEADER, options.remoteCommits.join(",")),
          options.private === true
            ? HttpClientRequest.setHeader(PRIVATE_PACK_HEADER, "1")
            : (request) => request,
          HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
        ),
        "uploading a pack",
      );
      return yield* decodeWith(driveJson.packUpload.decode, "pack answer")(answer);
    });

  /**
   * `PUT`s a file to a presigned storage URL: no bearer, the URL is the
   * permission. Through Node's own HTTP, which sends the file's length:
   * fetch streams a file body chunked, and storage refuses a `PUT` without one.
   */
  const putFile = (url: string, file: string, label: string) =>
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.put(url).pipe(
        HttpClientRequest.bodyFile(file, { contentType: "application/octet-stream" }),
        Effect.mapError(fileError(label)),
      );
      const response = yield* (yield* HttpClient.HttpClient).execute(request).pipe(
        Effect.mapError(
          () =>
            new DriveClientError({
              message: `${label}: storage could not be reached.`,
              retryable: true,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new DriveClientError({
          message: `${label} failed with HTTP ${response.status}`,
          status: response.status,
          retryable: isRetryableStatus(response.status),
        });
      }
    }).pipe(
      Effect.provide(NodeHttpClient.layerNodeHttp),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.retry(RETRY),
    );

  const uploadPack: DriveClient["uploadPack"] = (files, options = {}) =>
    Effect.gen(function* () {
      const [idxStat, packStat] = yield* Effect.all([fs.stat(files.idx), fs.stat(files.pack)]).pipe(
        Effect.mapError(fileError("sizing a pack")),
      );
      const idxSize = Number(idxStat.size);
      const packSize = Number(packStat.size);
      const offered = yield* postJson(
        DRIVE_PATHS.directUpload,
        driveJson.directUpload.encode({ packSize, idxSize }),
        "asking to upload a pack",
      ).pipe(
        Effect.flatMap(decodeWith(driveJson.directOffer.decode, "upload offer")),
        // A cloud from before direct uploads has no such route: upload inline.
        Effect.catchIf(
          (error) => error.status === 404,
          () => Effect.succeed({ _tag: "inline" } as const),
        ),
        Effect.catchIf(
          (error) => error.status === 413,
          (error) =>
            Effect.fail(
              new DriveTooLargeError({
                message: `This save is ${megabytes(packSize)}, more than a drive takes in one upload. ${error.message}`,
              }),
            ),
        ),
      );
      if (offered._tag === "inline") return yield* uploadInline(files, packSize, options);
      // Nothing reads an upload before it is committed, so both go at once.
      yield* Effect.all(
        [
          putFile(offered.pack, files.pack, "uploading a pack"),
          putFile(offered.idx, files.idx, "uploading a pack's index"),
        ],
        { concurrency: 2, discard: true },
      );
      const answer = yield* postJson(
        DRIVE_PATHS.directCommit,
        driveJson.directCommit.encode({
          uploadId: offered.uploadId,
          ...(options.remoteHead === undefined ? {} : { remoteHead: options.remoteHead }),
          ...(options.remoteCommits === undefined || options.remoteCommits.length === 0
            ? {}
            : { remoteCommits: options.remoteCommits }),
          ...(options.private === true ? { private: true } : {}),
        }),
        "storing an uploaded pack",
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
    shortcuts: (have) =>
      postJson(
        DRIVE_PATHS.shortcuts,
        driveJson.shortcutsRequest.encode({ have }),
        "listing the drive's shortcuts",
      ).pipe(
        Effect.flatMap(decodeWith(driveJson.shortcuts.decode, "shortcut list")),
        Effect.map((answer) => answer.shortcuts),
      ),
    downloadShortcutPack: (target, name, packDir) =>
      fetchPack(shortcutPacksPath(target), name, packDir),
    shortcutRemoteUrl: (target) => `${origin}${shortcutRemotePath(target)}`,
  } satisfies DriveClient;
});
