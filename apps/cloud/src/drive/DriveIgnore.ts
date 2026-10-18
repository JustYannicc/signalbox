import * as Schema from "effect/Schema";

import {
  Pattern,
  candidate,
  copyPattern,
  feedPattern,
  finishPattern,
  startPattern,
} from "./metadataIgnore/pattern.ts";

const IgnoreTest = Schema.Struct({ ignored: Schema.Boolean, unignored: Schema.Boolean });

/** A continuation depends on the candidate path, never on accumulated rule text. */
export const IgnoreEvaluationState = Schema.Struct({
  byteOffset: Schema.Number,
  pendingUtf8: Schema.Array(Schema.Number),
  spaces: Schema.Number,
  carriageReturns: Schema.Number,
  pattern: Schema.NullOr(Pattern),
  test: IgnoreTest,
  done: Schema.Boolean,
});
export type IgnoreEvaluationState = typeof IgnoreEvaluationState.Type;

export const beginIgnoreEvaluation = (): IgnoreEvaluationState => ({
  byteOffset: 0,
  pendingUtf8: [],
  spaces: 0,
  carriageReturns: 0,
  pattern: null,
  test: { ignored: false, unignored: false },
  done: false,
});

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const decode = (previous: ReadonlyArray<number>, bytes: Uint8Array, ended: boolean) => {
  const input = new Uint8Array(previous.length + bytes.length);
  input.set(previous);
  input.set(bytes, previous.length);
  let cut = input.length;
  if (!ended && cut > 0) {
    let lead = cut - 1;
    while (lead >= Math.max(0, cut - 3) && (input[lead]! & 0xc0) === 0x80) lead--;
    const byte = input[lead];
    const needed =
      byte === undefined
        ? 0
        : byte >= 0xf0 && byte <= 0xf4
          ? 4
          : byte >= 0xe0 && byte <= 0xef
            ? 3
            : byte >= 0xc2 && byte <= 0xdf
              ? 2
              : 0;
    if (needed > cut - lead) cut = lead;
  }
  return { text: decoder.decode(input.subarray(0, cut)), tail: [...input.subarray(cut)] };
};

/** Tests only this candidate. DFS has already admitted its proper parent directories. */
export const stepIgnoreRules = (input: {
  readonly state: IgnoreEvaluationState;
  readonly bytes: Uint8Array;
  readonly sourceEnded: boolean;
  readonly path: string;
  readonly directory: boolean;
}) => {
  if (input.bytes.length > 64 * 1024)
    throw new RangeError("Ignore input exceeds one bounded step.");
  const state = {
    ...input.state,
    pendingUtf8: [...input.state.pendingUtf8],
    pattern: input.state.pattern === null ? null : copyPattern(input.state.pattern),
    test: { ...input.state.test },
  };
  if (state.done) return { state, done: true, test: state.test };
  const context = candidate(input.path, input.directory);
  const decoded = decode(state.pendingUtf8, input.bytes, input.sourceEnded);
  state.pendingUtf8 = decoded.tail;
  state.byteOffset += input.bytes.length;
  const feed = (char: string) => {
    state.pattern ??= startPattern(context);
    feedPattern(state.pattern, char, context);
  };
  const repeat = (char: string, count: number) => {
    for (let index = 0; index < Math.min(count, context.text.length + 1); index++) feed(char);
  };
  const flush = () => {
    repeat(" ", state.spaces);
    repeat("\r", state.carriageReturns);
    state.spaces = state.carriageReturns = 0;
  };
  const finish = () => {
    if (state.spaces > 0 && state.pattern?.escaped) feed(" ");
    if (state.pattern !== null && finishPattern(state.pattern, context))
      state.test = { ignored: !state.pattern.negative, unignored: state.pattern.negative };
    state.pattern = null;
    state.spaces = state.carriageReturns = 0;
  };
  for (let index = 0; index < decoded.text.length; index++) {
    const char = decoded.text[index]!;
    if (char === "\n") finish();
    else if (char === "\r") state.carriageReturns++;
    else if (char === " ") {
      if (state.carriageReturns > 0) flush();
      state.spaces++;
    } else {
      flush();
      feed(char);
    }
  }
  if (input.sourceEnded) {
    finish();
    state.done = true;
  }
  return { state, done: state.done, test: state.test };
};
