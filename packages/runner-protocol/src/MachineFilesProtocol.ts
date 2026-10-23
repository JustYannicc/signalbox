import * as Schema from "effect/Schema";

import { jsonCodec } from "./jsonCodec.ts";

/** Full encoded JSON frames, including base64, stay below this wire limit. */
export const MACHINE_FILES_MAX_FRAME_BYTES = 1_048_576;
/** Leaves headroom for JSON fields and base64 expansion in a single lookup frame. */
export const MACHINE_FILES_MAX_CONTENT_BYTES = 512 * 1024;
export const MACHINE_FILES_MAX_READDIR_ENTRIES = 128;
export const MACHINE_FILES_MAX_OPERATIONS = 64;

const Id = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128));
const Path = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(4_096))
  .check(Schema.isPattern(/^\//))
  .check(Schema.isPattern(/^[^\0]*$/));
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Decimal = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9][0-9]*)$/));
const UnsignedDecimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/));
const UidOrMode = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(0xffff_ffff),
);
const Base64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);

export const MachineFileType = Schema.Literals([
  "file",
  "directory",
  "symlink",
  "fifo",
  "socket",
  "character",
  "block",
  "unknown",
]);
export type MachineFileType = typeof MachineFileType.Type;

/** POSIX stat data. Image-only sources omit native identity and birthtime they cannot attest. */
export const MachineFileStat = Schema.Struct({
  mode: UidOrMode,
  type: MachineFileType,
  size: UnsignedDecimal,
  uid: UidOrMode,
  gid: UidOrMode,
  dev: Schema.optional(UnsignedDecimal),
  ino: Schema.optional(UnsignedDecimal),
  nlink: UnsignedDecimal,
  atimeNs: Decimal,
  mtimeNs: Decimal,
  ctimeNs: Decimal,
  birthtimeNs: Schema.optional(Decimal),
});
export type MachineFileStat = typeof MachineFileStat.Type;

const MachineFileOperation = Schema.Union([
  Schema.Struct({ id: Id, op: Schema.Literals(["stat", "lstat"]), path: Path }),
  Schema.Struct({
    id: Id,
    op: Schema.Literal("readdir"),
    path: Path,
    cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
    limit: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0)).check(
        Schema.isLessThanOrEqualTo(MACHINE_FILES_MAX_READDIR_ENTRIES),
      ),
    ),
    withStat: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ id: Id, op: Schema.Literal("readlink"), path: Path }),
  Schema.Struct({
    id: Id,
    op: Schema.Literal("readRange"),
    path: Path,
    offset: Offset,
    length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(MACHINE_FILES_MAX_CONTENT_BYTES),
    ),
  }),
  Schema.Struct({
    id: Id,
    op: Schema.Literal("searchPath"),
    commands: Schema.Array(Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(255)))
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(64)),
    path: Schema.String.check(Schema.isMaxLength(16_384)).check(Schema.isPattern(/^[^\0]*$/)),
    cwd: Path,
  }),
]);
export type MachineFileOperation = typeof MachineFileOperation.Type;

export const MachineFilesRequest = Schema.Struct({
  type: Schema.Literal("machine.files.request"),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  requestId: Id,
  operations: Schema.Array(MachineFileOperation)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(MACHINE_FILES_MAX_OPERATIONS)),
});
export type MachineFilesRequest = typeof MachineFilesRequest.Type;

const OperationError = Schema.Struct({
  code: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(64)),
  message: Schema.String.check(Schema.isMaxLength(256)),
});

const OperationFailure = Schema.Struct({
  id: Id,
  op: Schema.String,
  error: OperationError,
});

const StatResult = Schema.Struct({
  id: Id,
  op: Schema.Literals(["stat", "lstat"]),
  stat: MachineFileStat,
});
const ReaddirResult = Schema.Struct({
  id: Id,
  op: Schema.Literal("readdir"),
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(1_024)),
      type: MachineFileType,
      stat: Schema.optional(MachineFileStat),
    }),
  ).check(Schema.isMaxLength(MACHINE_FILES_MAX_READDIR_ENTRIES)),
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
});
const ReadlinkResult = Schema.Struct({
  id: Id,
  op: Schema.Literal("readlink"),
  targetBase64: Base64,
});
const ReadRangeResult = Schema.Struct({
  id: Id,
  op: Schema.Literal("readRange"),
  offset: Offset,
  bytesRead: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(MACHINE_FILES_MAX_CONTENT_BYTES),
  ),
  bytesBase64: Base64,
  eof: Schema.Boolean,
});
const SearchPathResult = Schema.Struct({
  id: Id,
  op: Schema.Literal("searchPath"),
  matches: Schema.Array(
    Schema.Union([
      Schema.Struct({
        command: Schema.String,
        status: Schema.Literal("found"),
        path: Path,
        stat: MachineFileStat,
      }),
      Schema.Struct({
        command: Schema.String,
        status: Schema.Literals(["not_found", "permission_denied"]),
      }),
    ]),
  ).check(Schema.isMaxLength(64)),
});

export const MachineFileOperationResult = Schema.Union([
  StatResult,
  ReaddirResult,
  ReadlinkResult,
  ReadRangeResult,
  SearchPathResult,
  OperationFailure,
]);
export type MachineFileOperationResult = typeof MachineFileOperationResult.Type;

export const MachineFilesResult = Schema.Struct({
  type: Schema.Literal("machine.files.result"),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  requestId: Id,
  outcome: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("ok"),
      results: Schema.Array(MachineFileOperationResult).check(
        Schema.isMaxLength(MACHINE_FILES_MAX_OPERATIONS),
      ),
    }),
    Schema.Struct({
      status: Schema.Literal("error"),
      code: Schema.Literals([
        "stale_generation",
        "frame_too_large",
        "duplicate_operation_id",
        "lookup_failed",
      ]),
      message: Schema.String.check(Schema.isMaxLength(256)),
    }),
  ]),
});
export type MachineFilesResult = typeof MachineFilesResult.Type;

export const MachineFilesMessage = Schema.Union([MachineFilesRequest, MachineFilesResult]);
export type MachineFilesMessage = typeof MachineFilesMessage.Type;

export const machineFilesFrame = jsonCodec(MachineFilesMessage);

const textEncoder = new TextEncoder();
export const machineFilesFrameBytes = (message: MachineFilesMessage) =>
  textEncoder.encode(machineFilesFrame.encode(message)).byteLength;
