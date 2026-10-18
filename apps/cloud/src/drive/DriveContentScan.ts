import type { ProjectContentMatch, ProjectSearchContentsInput } from "@t3tools/contracts";
import { EMPTY_TREE } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import ignore from "ignore";

import { DriveReadError, type DriveReader } from "./DriveReader.ts";
import type { Oid, TreeEntry } from "./git/gitObjects.ts";
import { contentSnippet, isKnownBinaryPath, makeContentMatcher } from "./contentSearch/matching.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IGNORE_BYTES = 64 * 1024;
const MAX_SAVED_IGNORE_BYTES = 512 * 1024;
const MAX_MATCHING_LINES = 100;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const Frame = Schema.Struct({
  tree: Schema.String,
  path: Schema.String,
  nextEntry: Schema.Number,
  nextRule: Schema.Number,
  ruleOids: Schema.NullOr(Schema.Array(Schema.NullOr(Schema.String))),
  rules: Schema.Array(Schema.String),
});
const FilePosition = Schema.Struct({
  oid: Schema.String,
  path: Schema.String,
  byteOffset: Schema.Number,
  lineNumber: Schema.Number,
  matchingLines: Schema.Number,
});

/** Server-owned continuation state. Clients only receive an opaque lookup key. */
export const DriveContentScanState = Schema.Struct({
  commit: Schema.NullOr(Schema.String),
  stack: Schema.Array(Frame),
  file: Schema.NullOr(FilePosition),
  omitted: Schema.Boolean,
});
export type DriveContentScanState = typeof DriveContentScanState.Type;

export interface DriveContentScanBudget {
  readonly entries?: number;
  /** Must fit one allowed file. The default is twelve MiB. */
  readonly bytes?: number;
  readonly excludePaths?: ReadonlyArray<string>;
}

type Reader = Pick<DriveReader, "treeOf" | "tree" | "blob" | "sizes">;
type Failure = Effect.Error<ReturnType<DriveReader["object"]>>;
type Input = Omit<ProjectSearchContentsInput, "cwd">;
export interface DriveContentScanPage {
  readonly matches: ProjectContentMatch[];
  readonly truncated: boolean;
  readonly nextState?: DriveContentScanState;
  readonly regexFallbackError?: string;
}

/** Reads one bounded page from an immutable commit, preserving its DFS and file position. */
export const scanDriveContents = Effect.fn("scanDriveContents")(function* (
  reader: Reader,
  commit: Oid | null,
  input: Input,
  previous: DriveContentScanState | null = null,
  budget: DriveContentScanBudget = {},
): Effect.fn.Return<DriveContentScanPage, Failure> {
  const state = previous ?? {
    commit,
    stack: [
      {
        tree: yield* reader.treeOf(commit),
        path: "",
        nextEntry: 0,
        nextRule: 0,
        ruleOids: null,
        rules: [],
      },
    ],
    file: null,
    omitted: false,
  };
  const stack = state.stack.map((frame) => ({ ...frame, rules: [...frame.rules] }));
  let file = state.file === null ? null : { ...state.file };
  let omitted = state.omitted;
  let entriesRead = 0;
  let bytesRead = 0;
  const entryLimit = Math.max(1, budget.entries ?? 512);
  const byteLimit = Math.max(1, budget.bytes ?? 12 * 1024 * 1024);
  const matches: ProjectContentMatch[] = [];
  const matcher = makeContentMatcher(input);
  const trees = new Map<Oid, ReadonlyArray<TreeEntry>>();
  const ignoreMatchers = new Map<string, ReturnType<typeof ignore>>();
  const tree = (oid: Oid) =>
    Effect.gen(function* () {
      const cached = trees.get(oid);
      if (cached !== undefined) return cached;
      const size = oid === EMPTY_TREE ? 0 : (yield* reader.sizes([oid])).get(oid);
      if (size === undefined || size === null || size > MAX_FILE_BYTES) {
        return yield* new DriveReadError({
          message: "Cannot search a directory tree of unknown size or above 10 MiB.",
        });
      }
      if (size > byteLimit) {
        return yield* new DriveReadError({
          message: "The search byte budget cannot fit this directory tree.",
        });
      }
      if (bytesRead + size > byteLimit) return null;
      const entries = yield* reader.tree(oid);
      bytesRead += size;
      trees.set(oid, entries);
      return entries;
    });
  const excluded = (path: string) =>
    budget.excludePaths?.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ===
    true;
  const ignored = (path: string, directory: boolean) => {
    let result = false;
    // ripgrep gives .ignore precedence over .gitignore at every depth.
    for (const index of [0, 1]) {
      for (const frame of stack) {
        const contents = frame.rules[index];
        if (!contents) continue;
        const key = `${index}:${frame.path}`;
        let rules = ignoreMatchers.get(key);
        if (rules === undefined) {
          rules = ignore({ ignorecase: false }).add(contents);
          ignoreMatchers.set(key, rules);
        }
        const relative = path.slice(frame.path.length);
        const test = rules.test(`${relative}${directory ? "/" : ""}`);
        if (test.ignored) result = true;
        else if (test.unignored) result = false;
      }
    }
    return result;
  };
  const load = Effect.fn("scanDriveContents.load")(function* (oid: Oid, rules: boolean) {
    const size = oid === EMPTY_TREE ? 0 : (yield* reader.sizes([oid])).get(oid);
    if (size === undefined || size === null) {
      if (rules)
        return yield* new DriveReadError({
          message: "Cannot bound an ignore file of unknown size.",
        });
      omitted = true;
      return { kind: "skip" as const };
    }
    if (rules && size > MAX_IGNORE_BYTES) {
      return yield* new DriveReadError({
        message: "An ignore file exceeds the 64 KiB search limit.",
      });
    }
    if (size > MAX_FILE_BYTES || size === 0) return { kind: "skip" as const };
    if (size > byteLimit) {
      return yield* new DriveReadError({ message: "The search byte budget cannot fit this file." });
    }
    if (bytesRead + size > byteLimit) return { kind: "defer" as const };
    const bytes = yield* reader.blob(oid);
    bytesRead += bytes.length;
    if (bytes.length > (rules ? MAX_IGNORE_BYTES : MAX_FILE_BYTES)) {
      return yield* new DriveReadError({ message: "The file exceeds its recorded search size." });
    }
    return { kind: "bytes" as const, bytes };
  });

  while (stack.length > 0 || file !== null) {
    if (matches.length >= input.limit || entriesRead >= entryLimit) break;
    if (file !== null) {
      if (excluded(file.path) || isKnownBinaryPath(file.path)) {
        file = null;
        continue;
      }
      const loaded = yield* load(file.oid, false);
      if (loaded.kind === "defer") break;
      entriesRead++;
      if (loaded.kind === "skip" || loaded.bytes.includes(0)) {
        file = null;
        continue;
      }
      const bytes = loaded.bytes;
      while (file.byteOffset < bytes.length && matches.length < input.limit) {
        const start = file.byteOffset;
        const newline = bytes.indexOf(10, start);
        let end = newline === -1 ? bytes.length : newline;
        file.byteOffset = newline === -1 ? bytes.length : newline + 1;
        while (end > start && bytes[end - 1] === 13) end--;
        const lineBytes = bytes.subarray(start, end);
        const line = decoder.decode(lineBytes);
        const lineNumber = file.lineNumber++;
        if (!matcher.test(line)) continue;
        if (file.matchingLines >= MAX_MATCHING_LINES) {
          omitted = true;
          file = null;
          break;
        }
        file.matchingLines++;
        const lineContent = contentSnippet(lineBytes);
        const matchRanges = matcher.ranges(line, lineContent);
        if (matchRanges.length > 0)
          matches.push({ path: file.path, lineNumber, lineContent, matchRanges });
      }
      if (file !== null && file.byteOffset >= bytes.length) file = null;
      continue;
    }

    const frame = stack.at(-1)!;
    if (frame.ruleOids === null) {
      const entries = yield* tree(frame.tree);
      if (entries === null) break;
      frame.ruleOids = [".gitignore", ".ignore"].map(
        (name) =>
          entries.find(
            (entry) =>
              entry.name === name && (entry.kind === "file" || entry.kind === "executable"),
          )?.oid ?? null,
      );
    }
    if (frame.nextRule < 2) {
      const oid = frame.ruleOids[frame.nextRule];
      let contents = "";
      if (oid !== undefined && oid !== null) {
        const loaded = yield* load(oid, true);
        if (loaded.kind === "defer") break;
        entriesRead++;
        if (loaded.kind === "bytes") {
          const savedBytes = stack.reduce(
            (total, item) =>
              total + item.rules.reduce((sum, text) => sum + encoder.encode(text).length, 0),
            0,
          );
          if (savedBytes + loaded.bytes.length > MAX_SAVED_IGNORE_BYTES) {
            return yield* new DriveReadError({
              message: "Nested ignore files exceed the 512 KiB search limit.",
            });
          }
          contents = decoder.decode(loaded.bytes);
        }
      }
      frame.rules.push(contents);
      frame.nextRule++;
      continue;
    }
    const entries = yield* tree(frame.tree);
    if (entries === null) break;
    const entry = entries[frame.nextEntry];
    if (entry === undefined) {
      stack.pop();
      continue;
    }
    frame.nextEntry++;
    entriesRead++;
    const path = `${frame.path}${entry.name}`;
    if (entry.name === ".git" || excluded(path) || ignored(path, entry.kind === "directory"))
      continue;
    if (entry.kind === "directory") {
      stack.push({
        tree: entry.oid,
        path: `${path}/`,
        nextEntry: 0,
        nextRule: 0,
        ruleOids: null,
        rules: [],
      });
    } else if ((entry.kind === "file" || entry.kind === "executable") && !isKnownBinaryPath(path)) {
      file = { oid: entry.oid, path, byteOffset: 0, lineNumber: 1, matchingLines: 0 };
    }
  }
  while (stack.length > 0) {
    if (file !== null) break;
    const frame = stack.at(-1)!;
    const entries = trees.get(frame.tree);
    if (frame.nextRule < 2 || entries === undefined || frame.nextEntry < entries.length) break;
    stack.pop();
  }
  const nextState =
    stack.length > 0 || file !== null ? { commit: state.commit, stack, file, omitted } : undefined;
  return {
    matches,
    truncated: omitted || nextState !== undefined,
    ...(nextState === undefined ? {} : { nextState }),
    ...(matcher.regexFallbackError === undefined
      ? {}
      : { regexFallbackError: matcher.regexFallbackError }),
  };
});
