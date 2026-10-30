import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

import { CharacterClass, copyClass, feedClass, startClass } from "./characterClass.ts";

export const Pattern = Schema.Struct({
  root: Schema.Array(Schema.Number),
  base: Schema.Array(Schema.Number),
  prefix: Schema.Literals(["bom", "marker", "body"]),
  negative: Schema.Boolean,
  comment: Schema.Boolean,
  invalid: Schema.Boolean,
  length: Schema.Number,
  innerSlash: Schema.Boolean,
  lastSlash: Schema.Boolean,
  initial: Schema.Boolean,
  pendingSlash: Schema.Boolean,
  stars: Schema.Number,
  globstar: Schema.Literals(["none", "prefix", "middle"]),
  escaped: Schema.Boolean,
  escapedSlash: Schema.Boolean,
  bracket: Schema.NullOr(CharacterClass),
});
export type Pattern = Types.DeepMutable<typeof Pattern.Type>;

export const copyPattern = (state: typeof Pattern.Type): Pattern => ({
  ...state,
  root: [...state.root],
  base: [...state.base],
  bracket: state.bracket === null ? null : copyClass(state.bracket),
});

export interface Candidate {
  readonly text: string;
  readonly codes: ReadonlyArray<number>;
  readonly codeIndexes: ReadonlyMap<number, number>;
}

export const candidate = (path: string, directory: boolean): Candidate => {
  const text = `${path}${directory ? "/" : ""}`;
  const codes = [...new Set(text.split("").map((char) => char.charCodeAt(0)))];
  return { text, codes, codeIndexes: new Map(codes.map((code, index) => [code, index])) };
};

export const startPattern = ({ text }: Candidate): Pattern => ({
  root: [0],
  base: [text.lastIndexOf("/", text.length - (text.endsWith("/") ? 2 : 1)) + 1],
  prefix: "bom",
  negative: false,
  comment: false,
  invalid: false,
  length: 0,
  innerSlash: false,
  lastSlash: false,
  initial: true,
  pendingSlash: false,
  stars: 0,
  globstar: "none",
  escaped: false,
  escapedSlash: false,
  bracket: null,
});

const advance = (state: Pattern, operation: (positions: ReadonlyArray<number>) => number[]) => {
  state.root = operation(state.root);
  state.base = operation(state.base);
};

const one = (state: Pattern, text: string, predicate: (char: string) => boolean) =>
  advance(state, (positions) =>
    positions.filter((at) => at < text.length && predicate(text[at]!)).map((at) => at + 1),
  );

const repeat = (
  state: Pattern,
  text: string,
  predicate: (char: string) => boolean,
  minimum = 0,
) => {
  advance(state, (positions) => {
    const reached = new Set<number>();
    for (const at of positions) {
      if (minimum === 0) reached.add(at);
      for (let end = at; end < text.length && predicate(text[end]!); end++) {
        if (reached.has(end + 1)) break;
        reached.add(end + 1);
      }
    }
    return [...reached].sort((a, b) => a - b);
  });
};

const directories = (state: Pattern, text: string, prefix: boolean, minimum: number) => {
  advance(state, (positions) => {
    const reached = new Set<number>();
    for (const at of positions) {
      if (minimum === 0) reached.add(at);
      if (prefix) {
        for (let end = at; end < text.length && !/[\n\r\u2028\u2029]/u.test(text[end]!); end++) {
          if (text[end] === "/") {
            if (reached.has(end + 1)) break;
            reached.add(end + 1);
          }
        }
      } else {
        for (let end = at; end + 1 < text.length && text[end] === "/";) {
          const slash = text.indexOf("/", end + 1);
          if (slash === end + 1) break;
          const after = slash < 0 ? text.length : slash;
          if (reached.has(after)) break;
          reached.add(after);
          end = after;
        }
      }
    }
    return [...reached].sort((a, b) => a - b);
  });
};

const flush = (state: Pattern, text: string, final: boolean) => {
  if (state.globstar !== "none") {
    const middle = state.globstar === "middle";
    // A final /**/ requires a descendant directory; an inner /**/ can skip it.
    directories(state, text, !middle, final && middle ? 1 : 0);
    state.pendingSlash = middle;
    state.globstar = "none";
  }
  const afterSlash = state.pendingSlash;
  if (state.pendingSlash) {
    one(state, text, (char) => char === "/");
    state.pendingSlash = false;
  }
  if (state.stars > 0) {
    repeat(state, text, (char) => char !== "/", final && state.stars === 1 && afterSlash ? 1 : 0);
    state.stars = 0;
    state.initial = false;
  }
};

export const feedPattern = (state: Pattern, char: string, context: Candidate) => {
  if (state.prefix === "bom") {
    state.prefix = "marker";
    if (char === "\uFEFF") return;
  }
  if (state.prefix === "marker") {
    state.prefix = "body";
    if (char === "#") state.comment = true;
    if (char === "!") {
      state.negative = true;
      return;
    }
  }
  if (state.comment || state.invalid) return;
  state.escapedSlash = false;
  if (state.lastSlash) state.innerSlash = true;
  state.lastSlash = char === "/";
  const first = state.length++ === 0;
  const { text, codes } = context;
  if (state.bracket !== null) {
    const result = feedClass(state.bracket, char, codes);
    if (result === "invalid") state.invalid = true;
    if (result === "closed") {
      const bracket = state.bracket;
      one(
        state,
        text,
        (value) =>
          value !== "/" &&
          Boolean(bracket.matched[context.codeIndexes.get(value.charCodeAt(0))!]) !==
            bracket.negated,
      );
      state.bracket = null;
    }
    return;
  }
  if (state.escaped) {
    flush(state, text, false);
    one(state, text, (value) => value === char);
    state.escaped = false;
    state.escapedSlash = char === "/";
    state.initial = false;
    return;
  }
  if (char === "\\") {
    state.escaped = true;
    return;
  }
  if (char === "/") {
    if (first) return;
    if (state.stars === 2 && (state.pendingSlash || state.initial)) {
      state.globstar = state.pendingSlash ? "middle" : "prefix";
      state.stars = 0;
      state.pendingSlash = false;
      return;
    }
    flush(state, text, false);
    state.pendingSlash = true;
    return;
  }
  if (state.globstar !== "none") {
    const middle = state.globstar === "middle";
    directories(state, text, !middle, 0);
    state.pendingSlash = middle;
    state.globstar = "none";
  }
  if (char === "*") {
    state.stars = Math.min(3, state.stars + 1);
    return;
  }
  flush(state, text, false);
  state.initial = false;
  if (char === "[") state.bracket = startClass(codes);
  else one(state, text, char === "?" ? (value) => value !== "/" : (value) => value === char);
};

export const finishPattern = (state: Pattern, context: Candidate) => {
  if (
    state.comment ||
    state.invalid ||
    state.escaped ||
    state.escapedSlash ||
    state.bracket !== null ||
    state.length === 0
  )
    return false;
  const { text } = context;
  if (state.stars === 2 && state.pendingSlash) {
    one(state, text, (char) => char === "/");
    state.pendingSlash = false;
    state.stars = 0;
    repeat(state, text, (char) => !/[\n\r\u2028\u2029]/u.test(char), 1);
  } else flush(state, text, true);
  const positions = state.innerSlash ? state.root : state.base;
  return (
    positions.includes(text.length) ||
    (!state.lastSlash && text.endsWith("/") && positions.includes(text.length - 1))
  );
};
