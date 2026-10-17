import type { SearchHit } from "@signalbox/runner-protocol/ContextProtocol";
import { NonNegativeInt, PositiveInt } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the Runner's loopback context server has no T3 caller to check: the cloud authorizes every call with the thread's own token.
import { McpSchema, McpServer, Tool } from "effect/ai";

import type { ContextClient, ContextClientError } from "./RunnerContextClient.ts";
import { DRIVES_ROOT, type DrivesView } from "./RunnerDrivesView.ts";

/**
 * The context tool (#141), served to the harness by the Runner's local
 * context server as the `signalbox` MCP server. It answers "in that drive we
 * implemented X": search across the user's threads, the drives' history and
 * other threads' unreconciled work, then open a thread or a diff, and read any
 * file the user can read under `/drives`. Everything is read-only; the
 * harness's working directory is the only place it changes files. The same
 * server publishes the thread's own branch (`RunnerBranchTools.ts`).
 */

export const CONTEXT_SERVER_NAME = "signalbox";

export const CONTEXT_INSTRUCTIONS = [
  `Everything your user can read is under ${DRIVES_ROOT}: ${DRIVES_ROOT}/<owner>/My Drive, ${DRIVES_ROOT}/<owner>/Shared drives/<name> and ${DRIVES_ROOT}/<owner>/Shared with me/<name>, where an owner is Personal or one of their organizations.`,
  `It is read-only and pinned to the version at the start of this turn. Your working directory is your own drive, the only one you change: to reuse a file from another drive, copy it into your working directory.`,
  `When the user refers to work done elsewhere ("in drive B we implemented X"), call search_context first, then open_thread and drive_diff on what it found, and reproduce the change from the diff.`,
  `If search_context answers insufficient_evidence, say that you found nothing, with what you searched; never guess which work was meant.`,
  `Where ${DRIVES_ROOT} is not mounted as a folder, list_drives and read_drive_file read the same paths.`,
  `In a drive backed by a GitHub repository, push and create_pr publish this thread's branch; git push has no credential here.`,
  `The instructions of the folders this thread lives in come first in your AGENTS.md, top level first; they apply to all your work here, not to one drive's files.`,
  `Use preview_service_start with the project's exact dev-server command when its preview must return on a new machine; use preview_service_stop to remove it.`,
].join("\n");

const DrivePath = Schema.String.annotate({
  description: `A path under ${DRIVES_ROOT}, e.g. "${DRIVES_ROOT}/Acme/Shared drives/Billing/src/app.ts".`,
});
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).annotate({
  description: "A full commit id, as search_context or open_thread gave it.",
});

/** Search hits with drive ids turned into the paths the agent reads them at. */
const presentHit = (view: DrivesView, hit: SearchHit) => {
  const { driveId, ...rest } = hit;
  return { drive: driveId === null ? null : (view.drivePath(driveId) ?? driveId), ...rest };
};

/** Most bytes `read_drive_file` answers at once: a file beyond it is read in parts. */
const READ_LIMIT = 256 * 1024;

export const json = (value: unknown) => JSON.stringify(value, null, 1);

interface ToolSpec<S extends Schema.Top> {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  /** The answer: text, or content blocks when it carries more than text (a screenshot). */
  readonly handle: (
    input: S["Type"],
  ) => Effect.Effect<
    string | ReadonlyArray<McpSchema.ContentBlock>,
    ContextClientError | ToolError
  >;
  /** What the tool does beyond reading what the user can read. Absent: it only reads. */
  readonly writes?: { readonly destructive: boolean; readonly openWorld: boolean };
}

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String,
}) {}

export const fail = (message: string) => Effect.fail(new ToolError({ message }));

/** Arguments the tool's input schema refused. */
export const badArguments = (error: { readonly message: string }) =>
  new ToolError({ message: `Bad arguments: ${error.message}` });

export const register = <S extends Schema.Top & { readonly DecodingServices: never }>(
  spec: ToolSpec<S>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const decode = Schema.decodeUnknownEffect(spec.parameters);
    // oxlint-disable-next-line t3code/no-raw-mcp-registration -- the Runner's loopback context server has no T3 caller to check: the cloud authorizes every call with the thread's own token.
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: spec.name,
        description: spec.description,
        inputSchema: Tool.getJsonSchemaFromSchema(spec.parameters) as never,
        annotations:
          spec.writes === undefined
            ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
            : {
                readOnlyHint: false,
                destructiveHint: spec.writes.destructive,
                openWorldHint: spec.writes.openWorld,
              },
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        decode(payload).pipe(
          Effect.mapError(badArguments),
          Effect.flatMap(spec.handle),
          // The tool and its outcome, never its arguments or answer.
          Effect.withSpan("RunnerMcpTool", { attributes: { tool: spec.name } }),
          Effect.map(
            (answer) =>
              new McpSchema.CallToolResult({
                content: typeof answer === "string" ? [{ type: "text", text: answer }] : answer,
              }),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                content: [{ type: "text", text: error.message }],
              }),
            ),
          ),
        ),
    });
  });

/** The context tool's MCP tools, reading through `view` and its client. */
export const layerContextTools = (view: DrivesView) => {
  const client = Effect.suspend((): Effect.Effect<ContextClient, ToolError> => {
    const current = view.client();
    return current === null
      ? fail("The drives aren't open yet; they open with the thread's first turn.")
      : Effect.succeed(current);
  });

  return Layer.effectDiscard(
    Effect.all([
      register({
        name: "search_context",
        description:
          "Search what the user can read for work done before: their threads (titles, changed files, full conversations), each drive's history, and other threads' work not merged yet. Pass the distinctive words (a feature, file, error or term), not a sentence. Each result holds most of the words; when nothing does, the answer is insufficient_evidence, never a guess. Results name threads, commits and files to follow with open_thread, drive_diff and read_drive_file.",
        parameters: Schema.Struct({
          query: Schema.String,
          drive: Schema.optional(
            DrivePath.annotate({
              description: `Only this drive: its ${DRIVES_ROOT} path, or its name when that is unique.`,
            }),
          ),
        }),
        handle: ({ query, drive }) =>
          Effect.gen(function* () {
            const scope = drive === undefined ? null : view.driveOf(drive);
            if (drive !== undefined && scope === null) {
              return yield* fail(
                `${drive} is not a drive under ${DRIVES_ROOT}; list_drives shows them.`,
              );
            }
            const result = yield* (yield* client).search({
              query,
              driveId: scope?.driveId ?? null,
            });
            return result._tag === "found"
              ? json({
                  result: "found",
                  words: result.terms,
                  hits: result.hits.map((hit) => presentHit(view, hit)),
                  searched: result.searched,
                })
              : json({
                  result: "insufficient_evidence",
                  words: result.terms,
                  reason: result.reason,
                  searched: result.searched,
                });
          }),
      }),
      register({
        name: "open_thread",
        description:
          "Open a thread search_context found: its turns in order, each with the user's and agent's messages, the files it changed and the commits before and after it (for drive_diff). Without turn, every turn with messages cut short; with turn, that turn in full. Also names the thread's unmerged work, if any.",
        parameters: Schema.Struct({ threadId: Schema.String, turn: Schema.optional(PositiveInt) }),
        handle: ({ threadId, turn }) =>
          Effect.gen(function* () {
            const found = yield* (yield* client).thread({ threadId, turn: turn ?? null });
            if (found._tag === "not_found") {
              return yield* fail("No such thread, or it isn't one the user can see.");
            }
            const { driveId, ...rest } = found;
            return json({
              drive: driveId === null ? null : (view.drivePath(driveId) ?? driveId),
              ...rest,
            });
          }),
      }),
      register({
        name: "drive_diff",
        description:
          "The patch between two commits of one drive: what a turn, a commit or a thread's unmerged work changed. Use the commits search_context or open_thread gave (from: the earlier one, or parent/start/base; null for a turn that started from nothing).",
        parameters: Schema.Struct({
          drive: DrivePath,
          from: Schema.NullOr(Commit),
          to: Commit,
        }),
        handle: ({ drive, from, to }) =>
          Effect.gen(function* () {
            const found = view.driveOf(drive);
            if (found === null) return yield* fail(`${drive} is not a drive under ${DRIVES_ROOT}.`);
            const diff = yield* (yield* client).diff({ driveId: found.driveId, from, to });
            if (diff._tag === "missing") return yield* fail("That drive has no such commit.");
            if (diff.patch === "") return "No changes.";
            return diff.truncated ? `${diff.patch}\n[The patch was cut off here.]` : diff.patch;
          }),
      }),
      register({
        name: "list_drives",
        description: `List a folder under ${DRIVES_ROOT}: the user's owners (Personal and their organizations), their drives, or a folder in a drive. at reads the drive at another commit, such as a thread's unmerged work.`,
        parameters: Schema.Struct({
          path: Schema.optional(DrivePath),
          at: Schema.optional(Commit),
        }),
        handle: ({ path, at }) =>
          Effect.gen(function* () {
            const listed = yield* view.list(path ?? DRIVES_ROOT, at ?? null);
            if (listed === null)
              return yield* fail(`${path} is not a folder under ${DRIVES_ROOT}.`);
            if (listed.length === 0) return "(empty)";
            return listed
              .map((entry) =>
                entry.kind === "directory"
                  ? `${entry.name}/`
                  : `${entry.name}  ${entry.size} bytes`,
              )
              .join("\n");
          }),
      }),
      register({
        name: "read_drive_file",
        description: `Read a file under ${DRIVES_ROOT}, up to ${READ_LIMIT / 1024} KB from offset (a byte, 0 by default). at reads it at another commit of its drive.`,
        parameters: Schema.Struct({
          path: DrivePath,
          at: Schema.optional(Commit),
          offset: Schema.optional(NonNegativeInt),
        }),
        handle: ({ path, at, offset = 0 }) =>
          Effect.gen(function* () {
            const read = yield* view.read(path, at ?? null);
            switch (read._tag) {
              case "file": {
                // git's own test for binary: a NUL in the first 8000 bytes.
                if (read.bytes.subarray(0, 8000).includes(0)) {
                  return `${path} is a binary file of ${read.bytes.length} bytes.`;
                }
                const end = Math.min(read.bytes.length, offset + READ_LIMIT);
                const text = new TextDecoder().decode(read.bytes.subarray(offset, end));
                return end < read.bytes.length
                  ? `${text}\n[Cut off at byte ${end} of ${read.bytes.length}; read on with offset ${end}.]`
                  : text;
              }
              case "directory":
                return yield* fail(`${path} is a folder; list_drives lists it.`);
              case "too_large":
                return yield* fail(`${path} is too big to read here.`);
              case "missing":
                return yield* fail(`There is no ${path}.`);
            }
          }),
      }),
    ]),
  );
};
