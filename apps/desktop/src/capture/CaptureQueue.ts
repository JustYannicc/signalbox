import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  DesktopCapture,
  DesktopCaptureDestination,
  DesktopPendingCapture,
  DesktopSubmitCapture,
} from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const CAPTURE_ID_PATTERN = /^[a-f0-9-]+$/i;
const StoredDestinations = Schema.Array(DesktopCaptureDestination).check(Schema.isMaxLength(2_000));
const DestinationsJson = Schema.fromJsonString(StoredDestinations);
const PendingCaptureJson = Schema.fromJsonString(DesktopPendingCapture);
const decodeDestinations = Schema.decodeUnknownEffect(DestinationsJson);
const encodeDestinations = Schema.encodeEffect(DestinationsJson);
const decodePendingCapture = Schema.decodeUnknownEffect(PendingCaptureJson);
const encodePendingCapture = Schema.encodeEffect(PendingCaptureJson);

const CaptureQueueOperation = Schema.Literals([
  "initialize",
  "read-entry",
  "write-entry",
  "list-entries",
  "read-file",
  "write-file",
  "remove-entry",
  "read-destinations",
  "write-destinations",
  "duplicate-id",
  "invalid-destination",
]);

export class CaptureQueueError extends Schema.TaggedError<CaptureQueueError>()(
  "CaptureQueueError",
  {
    operation: CaptureQueueOperation,
    captureId: Schema.NullOr(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "invalid-destination")
      return "This capture's folder is unavailable. Reconnect its account or pick a folder to save.";
    const capture = this.captureId === null ? "" : ` for capture ${this.captureId}`;
    return `Quick capture queue failed during ${this.operation}${capture}.`;
  }
}

export class CaptureQueue extends Context.Service<
  CaptureQueue,
  {
    readonly destinations: Effect.Effect<
      ReadonlyArray<typeof DesktopCaptureDestination.Type>,
      CaptureQueueError
    >;
    readonly setDestinations: (
      destinations: ReadonlyArray<typeof DesktopCaptureDestination.Type>,
    ) => Effect.Effect<void, CaptureQueueError>;
    readonly listPending: Effect.Effect<
      ReadonlyArray<typeof DesktopPendingCapture.Type>,
      CaptureQueueError
    >;
    readonly submit: (
      input: typeof DesktopSubmitCapture.Type,
    ) => Effect.Effect<typeof DesktopPendingCapture.Type, CaptureQueueError>;
    readonly read: (id: string) => Effect.Effect<typeof DesktopCapture.Type, CaptureQueueError>;
    readonly acknowledge: (id: string) => Effect.Effect<void, CaptureQueueError>;
    readonly reportFailure: (id: string, message: string) => Effect.Effect<void, CaptureQueueError>;
  }
>()("@t3tools/desktop/capture/CaptureQueue") {}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
};

const equalCapture = (
  left: typeof DesktopCapture.Type,
  right: typeof DesktopSubmitCapture.Type,
): boolean =>
  left.text === right.text &&
  left.destinationKey === right.destinationKey &&
  left.source === right.source &&
  left.open === right.open &&
  left.files.length === right.files.length &&
  left.files.every((file, index) => {
    const incoming = right.files[index];
    return (
      incoming !== undefined &&
      file.id === incoming.id &&
      file.name === incoming.name &&
      file.mimeType === incoming.mimeType &&
      file.sizeBytes === incoming.sizeBytes &&
      equalBytes(file.bytes, incoming.bytes)
    );
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const mutex = yield* Semaphore.make(1);
  const directory = path.join(environment.stateDir, "captures");
  const destinationsPath = path.join(directory, "destinations.json");

  const queueError = (
    operation: typeof CaptureQueueOperation.Type,
    captureId: string | null,
    cause?: unknown,
  ) => new CaptureQueueError({ operation, captureId, ...(cause === undefined ? {} : { cause }) });

  const readJson = <A>(
    filePath: string,
    decode: (raw: string) => Effect.Effect<A, Schema.SchemaError>,
    captureId: string | null,
  ) =>
    fs.readFileString(filePath).pipe(
      Effect.flatMap(decode),
      Effect.mapError((cause) =>
        queueError(
          filePath === destinationsPath ? "read-destinations" : "read-entry",
          captureId,
          cause,
        ),
      ),
    );

  const entryDirectory = (id: string) => path.join(directory, id);
  const entryMetadataPath = (id: string) => path.join(entryDirectory(id), "capture.json");

  const readEntry = (id: string) => readJson(entryMetadataPath(id), decodePendingCapture, id);

  const read = Effect.fn("desktop.captureQueue.read")(function* (id: string) {
    if (!CAPTURE_ID_PATTERN.test(id)) return yield* Effect.fail(queueError("read-entry", id));
    const entry = yield* readJson(entryMetadataPath(id), decodePendingCapture, id);
    const files = yield* Effect.forEach(
      entry.files,
      (file) =>
        fs.readFile(path.join(entryDirectory(id), `${file.id}.bin`)).pipe(
          Effect.mapError((cause) => queueError("read-file", id, cause)),
          Effect.map((bytes) => ({ ...file, bytes })),
        ),
      { concurrency: 1 },
    );
    return { ...entry, files };
  });

  const listPending = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => queueError("list-entries", null, cause)));
        const ids = entries.filter((entry) => CAPTURE_ID_PATTERN.test(entry));
        const entriesOrMissing = yield* Effect.forEach(
          ids,
          (id) =>
            readEntry(id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Skipping unreadable quick capture; its files were preserved", {
                  captureId: id,
                  operation: error.operation,
                }).pipe(Effect.as(null)),
              ),
            ),
          { concurrency: 1 },
        );
        const pending = entriesOrMissing.filter((entry) => entry !== null);
        return pending.toSorted((left, right) => left.capturedAt - right.capturedAt);
      }),
    )
    .pipe(Effect.withSpan("desktop.captureQueue.listPending"));

  const destinations = Effect.gen(function* () {
    const exists = yield* fs
      .exists(destinationsPath)
      .pipe(Effect.mapError((cause) => queueError("read-destinations", null, cause)));
    return exists ? yield* readJson(destinationsPath, decodeDestinations, null) : [];
  });

  const setDestinations = (next: ReadonlyArray<typeof DesktopCaptureDestination.Type>) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError((cause) => queueError("write-destinations", null, cause)));
        const suffix = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => queueError("write-destinations", null, cause)));
        const encoded = yield* encodeDestinations(next).pipe(
          Effect.mapError((cause) => queueError("write-destinations", null, cause)),
        );
        const temporary = `${destinationsPath}.${suffix}.tmp`;
        yield* fs
          .writeFileString(temporary, `${encoded}\n`)
          .pipe(Effect.mapError((cause) => queueError("write-destinations", null, cause)));
        yield* fs.rename(temporary, destinationsPath).pipe(
          Effect.mapError((cause) => queueError("write-destinations", null, cause)),
          Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        );
      }),
    );

  const submit = (input: typeof DesktopSubmitCapture.Type) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const currentDestinations = yield* destinations;
        if (
          input.destinationKey === null ||
          !currentDestinations.some((destination) => destination.key === input.destinationKey)
        ) {
          return yield* Effect.fail(queueError("invalid-destination", input.id));
        }
        const existing = yield* fs
          .exists(entryDirectory(input.id))
          .pipe(Effect.mapError((cause) => queueError("read-entry", input.id, cause)));
        if (existing) {
          const previous = yield* read(input.id);
          if (!equalCapture(previous, input)) {
            return yield* Effect.fail(queueError("duplicate-id", input.id));
          }
          return {
            ...previous,
            files: previous.files.map(({ bytes: _bytes, ...file }) => file),
          };
        }

        const capturedAt = yield* Clock.currentTimeMillis;
        const pending: typeof DesktopPendingCapture.Type = {
          id: input.id,
          text: input.text,
          files: input.files.map(({ bytes: _bytes, ...file }) => file),
          destinationKey: input.destinationKey,
          source: input.source,
          capturedAt,
          open: input.open,
          deliveryError: null,
        };
        const suffix = (yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => queueError("write-entry", input.id, cause)))).replaceAll(
          "-",
          "",
        );
        const encoded = yield* encodePendingCapture(pending).pipe(
          Effect.mapError((cause) => queueError("write-entry", input.id, cause)),
        );
        const temporaryDirectory = path.join(directory, `${input.id}.tmp-${suffix}`);
        yield* Effect.gen(function* () {
          yield* fs
            .makeDirectory(temporaryDirectory, { recursive: true })
            .pipe(Effect.mapError((cause) => queueError("write-entry", input.id, cause)));
          yield* Effect.forEach(
            input.files,
            (file) =>
              fs
                .writeFile(path.join(temporaryDirectory, `${file.id}.bin`), file.bytes)
                .pipe(Effect.mapError((cause) => queueError("write-file", input.id, cause))),
            { concurrency: 1 },
          );
          yield* fs
            .writeFileString(path.join(temporaryDirectory, "capture.json"), `${encoded}\n`)
            .pipe(Effect.mapError((cause) => queueError("write-entry", input.id, cause)));
          yield* fs
            .rename(temporaryDirectory, entryDirectory(input.id))
            .pipe(Effect.mapError((cause) => queueError("write-entry", input.id, cause)));
        }).pipe(
          Effect.ensuring(
            fs.remove(temporaryDirectory, { force: true, recursive: true }).pipe(Effect.ignore),
          ),
        );
        return pending;
      }),
    );

  const acknowledge = (id: string) =>
    mutex.withPermits(1)(
      fs
        .remove(entryDirectory(id), { force: true, recursive: true })
        .pipe(Effect.mapError((cause) => queueError("remove-entry", id, cause))),
    );

  const reportFailure = (id: string, message: string) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const entry = yield* readJson(entryMetadataPath(id), decodePendingCapture, id);
        const next = {
          ...entry,
          deliveryError: message.trim().slice(0, 2_000) || "Couldn't save this capture.",
        };
        const suffix = (yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => queueError("write-entry", id, cause)))).replaceAll(
          "-",
          "",
        );
        const encoded = yield* encodePendingCapture(next).pipe(
          Effect.mapError((cause) => queueError("write-entry", id, cause)),
        );
        const temporary = `${entryMetadataPath(id)}.${suffix}.tmp`;
        yield* fs
          .writeFileString(temporary, `${encoded}\n`)
          .pipe(Effect.mapError((cause) => queueError("write-entry", id, cause)));
        yield* fs.rename(temporary, entryMetadataPath(id)).pipe(
          Effect.mapError((cause) => queueError("write-entry", id, cause)),
          Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        );
      }),
    );

  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError((cause) => queueError("initialize", null, cause)));

  return CaptureQueue.of({
    destinations,
    setDestinations,
    listPending,
    submit,
    read,
    acknowledge,
    reportFailure,
  });
});

export const layer = Layer.effect(CaptureQueue, make);
