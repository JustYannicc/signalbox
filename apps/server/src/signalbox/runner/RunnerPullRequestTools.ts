import {
  AGENT_PULL_REQUEST_TOOL,
  CommentPullRequest,
  EditPullRequest,
  PR_IMAGE_LIMIT,
  PullRequestImageType,
  ReadPullRequest,
  ReplyPullRequest,
  type Request,
} from "@signalbox/runner-protocol/PullRequestTools";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { answer, automationCaller } from "./RunnerAutomationTools.ts";
import { fail, register, ToolError } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

const writes = { destructive: false, openWorld: true } as const;
const NumberInput = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const UploadImageInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path to a local PNG, JPEG, GIF or WebP image no larger than 10 MiB.",
  }),
  number: Schema.optional(NumberInput),
  operationId: ReplyPullRequest.fields.operationId,
});

const mimeTypeOf = (bytes: Uint8Array): typeof PullRequestImageType.Type | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
};

const extensionFor: Record<typeof PullRequestImageType.Type, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const safeImageName = (
  path: Path.Path,
  filePath: string,
  mimeType: typeof PullRequestImageType.Type,
) => {
  const base = path.basename(filePath).replace(/\.[^.]*$/, "");
  const stem =
    base
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[._-]+$/, "")
      .slice(0, 195) || "image";
  return `${stem}${extensionFor[mimeType]}`;
};

/** Read no file until stat confirms the image can fit the shared upload limit. */
const readImage = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: typeof UploadImageInput.Type,
) =>
  Effect.gen(function* () {
    if (!path.isAbsolute(input.path)) {
      return yield* fail("Pass the image's absolute path on this machine.");
    }
    const filePath = path.resolve(input.path);
    const info = yield* fs
      .stat(filePath)
      .pipe(
        Effect.mapError(() => new ToolError({ message: "That image file could not be read." })),
      );
    const size = Number(info.size);
    if (info.type !== "File" || !Number.isSafeInteger(size) || size < 1 || size > PR_IMAGE_LIMIT) {
      return yield* fail(`Choose an image file from 1 byte through ${PR_IMAGE_LIMIT} bytes.`);
    }
    const chunks = yield* Stream.runFold(
      fs.stream(filePath, { bytesToRead: PR_IMAGE_LIMIT + 1 }),
      () => [] as Array<Uint8Array>,
      (all, chunk) => {
        all.push(chunk);
        return all;
      },
    ).pipe(Effect.mapError(() => new ToolError({ message: "That image file could not be read." })));
    const byteLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (byteLength < 1 || byteLength > PR_IMAGE_LIMIT) {
      return yield* fail(`Choose an image file from 1 byte through ${PR_IMAGE_LIMIT} bytes.`);
    }
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      byteLength,
    );
    const mimeType = mimeTypeOf(bytes);
    if (mimeType === null) {
      return yield* fail("The file contents are not a supported PNG, JPEG, GIF or WebP image.");
    }
    return {
      name: safeImageName(path, filePath, mimeType),
      mimeType,
      base64: Buffer.from(bytes).toString("base64"),
    };
  });

/** Folder-scoped PR MCP tools. The cloud gets the thread's drive token, never a GitHub token. */
export const layerRunnerPullRequestTools = (view: DrivesView) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ask = automationCaller(view);
      const call = (request: Request, retry: boolean) =>
        ask(AGENT_PULL_REQUEST_TOOL, request, retry).pipe(Effect.map(answer));

      yield* Effect.all([
        register({
          name: "read_pr",
          description:
            "Read this thread's pull request, including its description, conversation and review comments. Omit number to read this thread's own pull request.",
          parameters: ReadPullRequest,
          handle: ({ number }) =>
            call({ _tag: "read", ...(number === undefined ? {} : { number }) }, true),
        }),
        register({
          name: "edit_pr",
          description:
            "Replace this thread's pull request description with the supplied Markdown body. Omit number to use this thread's own pull request.",
          parameters: EditPullRequest,
          writes,
          handle: ({ body, number }) =>
            call({ _tag: "edit", body, ...(number === undefined ? {} : { number }) }, false),
        }),
        register({
          name: "comment_pr",
          description:
            "Post a conversation comment on this thread's pull request. Reuse operationId only when retrying the same comment.",
          parameters: CommentPullRequest,
          writes,
          handle: ({ body, operationId, number }) =>
            call(
              { _tag: "comment", body, operationId, ...(number === undefined ? {} : { number }) },
              false,
            ),
        }),
        register({
          name: "reply_to_pr_review",
          description:
            "Reply to a review comment on this thread's pull request. commentId comes from read_pr; reuse operationId only when retrying the same reply.",
          parameters: ReplyPullRequest,
          writes,
          handle: ({ body, commentId, operationId, number }) =>
            call(
              {
                _tag: "reply",
                body,
                commentId,
                operationId,
                ...(number === undefined ? {} : { number }),
              },
              false,
            ),
        }),
        register({
          name: "upload_pr_image",
          description:
            "Upload a local image to this thread's pull request and return its Markdown reference. Pass an absolute path; supported formats are PNG, JPEG, GIF and WebP up to 10 MiB. Reuse operationId only when retrying the same image.",
          parameters: UploadImageInput,
          writes,
          handle: ({ number, operationId, path: filePath }) =>
            readImage(fs, path, { number, operationId, path: filePath }).pipe(
              Effect.flatMap((image) =>
                call(
                  {
                    _tag: "image",
                    ...image,
                    operationId,
                    ...(number === undefined ? {} : { number }),
                  },
                  false,
                ),
              ),
            ),
        }),
      ]);
    }),
  );
