import type { ProjectContentMatch, ProjectSearchContentsInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DriveReadError } from "./DriveReader.ts";
import { beginTreePage, TreePagePosition } from "./DriveTreePage.ts";
import { beginIgnoreEvaluation, IgnoreEvaluationState, stepIgnoreRules } from "./DriveIgnore.ts";
import { isKnownBinaryPath, makeContentMatcher } from "./contentSearch/matching.ts";
import { metadataPages, type MetadataReader } from "./contentSearch/metadataPages.ts";

const Entry = Schema.Struct({
  name: Schema.String,
  oid: Schema.String,
  mode: Schema.String,
  kind: Schema.Literals(["file", "executable", "symlink", "directory", "submodule"]),
});
const Frame = Schema.Struct({
  tree: Schema.String,
  path: Schema.String,
  position: TreePagePosition,
  rulePosition: TreePagePosition,
  rulesDiscovered: Schema.Boolean,
  ruleOids: Schema.Array(Schema.NullOr(Schema.String)),
});
const FilePosition = Schema.Struct({
  oid: Schema.String,
  path: Schema.String,
  byteOffset: Schema.Number,
  lineNumber: Schema.Number,
  searchOffset: Schema.Number,
  matchingLines: Schema.Number,
});
const Candidate = Schema.Struct({
  entry: Entry,
  path: Schema.String,
  scope: Schema.Number,
  rule: Schema.Number,
  evaluation: Schema.NullOr(IgnoreEvaluationState),
  test: Schema.Struct({ ignored: Schema.Boolean, unignored: Schema.Boolean }),
});

/** Server-owned positions contain object ids and parser state, never accumulated rules. */
export const DriveContentScanState = Schema.Struct({
  version: Schema.Literal(2),
  commit: Schema.NullOr(Schema.String),
  initialized: Schema.Boolean,
  stack: Schema.Array(Frame),
  file: Schema.NullOr(FilePosition),
  candidate: Schema.NullOr(Candidate),
  omitted: Schema.Boolean,
});
export type DriveContentScanState = typeof DriveContentScanState.Type;

export interface DriveContentScanBudget {
  readonly entries?: number;
  readonly bytes?: number;
  readonly excludePaths?: ReadonlyArray<string>;
}
type Input = Omit<ProjectSearchContentsInput, "cwd">;
type Failure =
  | Effect.Error<ReturnType<MetadataReader["metadata"]["bytes"]>>
  | Effect.Error<ReturnType<MetadataReader["searchTreeOf"]>>
  | Effect.Error<ReturnType<MetadataReader["sizes"]>>;
export interface DriveContentScanPage {
  readonly matches: ProjectContentMatch[];
  readonly truncated: boolean;
  readonly nextState?: DriveContentScanState;
  readonly regexFallbackError?: string;
}
const frameAt = (tree: string, path: string) => {
  const ruleOids: Array<string | null> = [null, null];
  return {
    tree,
    path,
    position: beginTreePage(),
    rulePosition: beginTreePage(),
    rulesDiscovered: false,
    ruleOids,
  };
};

/** A bounded DFS over immutable metadata pages. Ignore evaluation finishes before admission. */
export const scanDriveContents = Effect.fn("scanDriveContents")(function* (
  reader: MetadataReader,
  commit: string | null,
  input: Input,
  previous: DriveContentScanState | null = null,
  budget: DriveContentScanBudget = {},
): Effect.fn.Return<DriveContentScanPage, Failure> {
  const state: DriveContentScanState = previous ?? {
    version: 2,
    commit,
    initialized: false,
    stack: [],
    file: null,
    candidate: null,
    omitted: false,
  };
  const stack = state.stack.map((frame) => ({ ...frame, ruleOids: [...frame.ruleOids] }));
  let initialized = state.initialized;
  let file = state.file === null ? null : { ...state.file };
  let candidate = state.candidate === null ? null : { ...state.candidate };
  let omitted = state.omitted;
  const pages = metadataPages(
    reader,
    Math.max(1, budget.entries ?? 512),
    Math.max(1, budget.bytes ?? 12 * 1024 * 1024),
  );
  const matches: ProjectContentMatch[] = [];
  const matcher = makeContentMatcher(input);
  const excluded = (path: string) =>
    budget.excludePaths?.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ===
    true;

  if (!initialized) {
    const root = yield* reader.searchTreeOf(state.commit);
    if (root.ready) {
      stack.push(frameAt(root.tree, ""));
      initialized = true;
    }
  }
  while (pages.available() && matches.length < input.limit && (stack.length > 0 || file !== null)) {
    if (file !== null) {
      const loaded = yield* pages.blob(file.oid);
      if (loaded.kind === "defer") break;
      if (loaded.kind === "skip" || loaded.bytes.includes(0)) {
        file = null;
        continue;
      }
      let paused = false;
      for (const match of matcher.lines(loaded.bytes, file)) {
        if (file.matchingLines >= 100) {
          omitted = true;
          file = null;
          break;
        }
        file.matchingLines++;
        file.byteOffset = match.byteOffset;
        file.lineNumber = match.lineNumber + 1;
        file.searchOffset = match.searchOffset;
        const { lineNumber, lineContent, matchRanges } = match;
        if (matchRanges.length > 0)
          matches.push({ path: file.path, lineNumber, lineContent, matchRanges });
        if (matches.length >= input.limit) {
          paused = true;
          break;
        }
      }
      if (file !== null && (!paused || file.byteOffset >= loaded.bytes.length)) file = null;
      continue;
    }
    if (candidate !== null) {
      if (candidate.scope < 0) {
        if (candidate.entry.kind === "directory")
          stack.push(frameAt(candidate.entry.oid, `${candidate.path}/`));
        else
          file = {
            oid: candidate.entry.oid,
            path: candidate.path,
            byteOffset: 0,
            lineNumber: 1,
            searchOffset: 0,
            matchingLines: 0,
          };
        candidate = null;
        continue;
      }
      if (candidate.rule === 2) {
        if (candidate.test.ignored) candidate = null;
        else if (candidate.test.unignored) candidate.scope = -1;
        else {
          candidate.scope--;
          candidate.rule = 0;
          candidate.test = { ignored: false, unignored: false };
        }
        continue;
      }
      const scope = stack[candidate.scope]!;
      const oid = scope.ruleOids[candidate.rule];
      if (oid === null || oid === undefined) {
        candidate.rule++;
        continue;
      }
      const evaluation = candidate.evaluation ?? beginIgnoreEvaluation();
      const page = yield* pages.chunk(oid, evaluation.byteOffset);
      if (page === null) break;
      const pending = candidate;
      const checked = yield* Effect.try({
        try: () =>
          stepIgnoreRules({
            state: evaluation,
            bytes: page.bytes,
            sourceEnded: page.complete,
            path: pending.path.slice(scope.path.length),
            directory: pending.entry.kind === "directory",
          }),
        catch: (cause) =>
          new DriveReadError({ message: "The search ignore rules are invalid.", cause }),
      });
      if (checked.done) {
        if (checked.test.ignored || checked.test.unignored) candidate.test = checked.test;
        candidate.evaluation = null;
        candidate.rule++;
      } else candidate.evaluation = checked.state;
      continue;
    }
    const frame = stack.at(-1)!;
    const position = frame.rulesDiscovered ? frame.position : frame.rulePosition;
    const next = yield* pages.entry(frame.tree, position);
    if (next === null) break;
    if (!frame.rulesDiscovered) {
      frame.rulePosition = next.next;
      if (next.entry === null) {
        if (next.done) frame.rulesDiscovered = true;
      } else if (next.entry.kind === "file" || next.entry.kind === "executable") {
        const rule = [".gitignore", ".ignore"].indexOf(next.entry.name);
        if (rule >= 0 && frame.ruleOids[rule] === null) frame.ruleOids[rule] = next.entry.oid;
      }
      continue;
    }
    frame.position = next.next;
    if (next.entry === null) {
      if (next.done) stack.pop();
      continue;
    }
    const entry = next.entry;
    const path = `${frame.path}${entry.name}`;
    if (
      entry.name === ".git" ||
      excluded(path) ||
      (entry.kind !== "directory" &&
        ((entry.kind !== "file" && entry.kind !== "executable") || isKnownBinaryPath(path)))
    )
      continue;
    candidate = {
      entry,
      path,
      scope: stack.length - 1,
      rule: 0,
      evaluation: null,
      test: { ignored: false, unignored: false },
    };
  }
  if (file === null && candidate === null) {
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (!frame.rulesDiscovered || !pages.finished(frame.tree, frame.position)) break;
      stack.pop();
    }
  }
  const nextState =
    !initialized || stack.length > 0 || file !== null || candidate !== null
      ? { version: 2 as const, commit: state.commit, initialized, stack, file, candidate, omitted }
      : undefined;
  return {
    matches,
    truncated: omitted || nextState !== undefined,
    ...(nextState === undefined ? {} : { nextState }),
    ...(matcher.regexFallbackError === undefined
      ? {}
      : { regexFallbackError: matcher.regexFallbackError }),
  };
});
