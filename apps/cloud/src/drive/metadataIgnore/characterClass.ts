import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

const Core = Schema.Struct({
  matched: Schema.Array(Schema.Number),
  lead: Schema.Literals(["initial", "negated", "member"]),
  negated: Schema.Boolean,
  previous: Schema.NullOr(Schema.Number),
  escaped: Schema.Boolean,
  range: Schema.Boolean,
  maybePosix: Schema.Boolean,
});

export const CharacterClass = Schema.Struct({
  ...Core.fields,
  posix: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      tooLong: Schema.Boolean,
      lastColon: Schema.Boolean,
      fallback: Core,
    }),
  ),
});
type Core = Types.Mutable<typeof Core.Type>;
export type CharacterClass = Types.DeepMutable<typeof CharacterClass.Type>;

export const copyClass = (state: typeof CharacterClass.Type): CharacterClass => ({
  ...state,
  matched: [...state.matched],
  posix:
    state.posix === null
      ? null
      : {
          ...state.posix,
          fallback: { ...state.posix.fallback, matched: [...state.posix.fallback.matched] },
        },
});

const classes: Record<string, (char: string) => boolean> = {
  alnum: (char) => /[0-9A-Za-z]/u.test(char),
  alpha: (char) => /[A-Za-z]/u.test(char),
  blank: (char) => /[ \t]/u.test(char),
  cntrl: (char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127,
  digit: (char) => /[0-9]/u.test(char),
  graph: (char) => /[!-.0-~]/u.test(char),
  lower: (char) => /[a-z]/u.test(char),
  print: (char) => /[ -.0-~]/u.test(char),
  punct: (char) => /[!-.:-@[-`{-~]/u.test(char),
  space: (char) => /[ \t\n\r]/u.test(char),
  upper: (char) => /[A-Z]/u.test(char),
  xdigit: (char) => /[0-9A-Fa-f]/u.test(char),
};

export const startClass = (codes: ReadonlyArray<number>): CharacterClass => ({
  matched: codes.map(() => 0),
  lead: "initial",
  negated: false,
  previous: null,
  escaped: false,
  range: false,
  maybePosix: false,
  posix: null,
});

const member = (state: Core, from: number, to: number, codes: ReadonlyArray<number>) => {
  state.matched = state.matched.map((matched, index) =>
    matched || (codes[index]! >= from && codes[index]! <= to) ? 1 : 0,
  );
};

const literal = (state: Core, code: number, codes: ReadonlyArray<number>) => {
  member(state, code, code, codes);
  state.previous = code;
  state.lead = "member";
};

const feedCore = (
  state: Core,
  char: string,
  codes: ReadonlyArray<number>,
  posix: boolean,
): "open" | "closed" | "posix" => {
  if (state.maybePosix) {
    state.maybePosix = false;
    if (char === ":" && posix) return "posix";
    literal(state, 91, codes);
  }
  const code = char.charCodeAt(0);
  if (state.escaped) {
    state.escaped = false;
    if (state.range) {
      member(state, state.previous!, code, codes);
      state.previous = null;
      state.range = false;
      state.lead = "member";
    } else literal(state, code, codes);
    return "open";
  }
  if (state.range) {
    if (char === "\\") {
      state.escaped = true;
      return "open";
    }
    state.range = false;
    if (char === "]") {
      literal(state, 45, codes);
      return "closed";
    }
    member(state, state.previous!, code, codes);
    state.previous = null;
    state.lead = "member";
    return "open";
  }
  if (state.lead === "initial" && (char === "!" || char === "^")) {
    state.negated = true;
    state.lead = "negated";
    return "open";
  }
  if (char === "]" && state.lead === "member") return "closed";
  if (char === "\\") state.escaped = true;
  else if (char === "-" && state.previous !== null) state.range = true;
  else if (char === "[" && posix) state.maybePosix = true;
  else literal(state, code, codes);
  return "open";
};

/** A class stores membership only for characters present in the candidate path. */
export const feedClass = (
  state: CharacterClass,
  char: string,
  codes: ReadonlyArray<number>,
): "open" | "closed" | "invalid" => {
  if (state.posix !== null) {
    const pending = state.posix;
    const fallback = feedCore(pending.fallback, char, codes, false);
    if (char !== "]") {
      pending.lastColon = char === ":";
      if (pending.name.length < 9) pending.name += char;
      else pending.tooLong = true;
      return "open";
    }
    state.posix = null;
    if (pending.lastColon) {
      const name = pending.name.slice(0, -1);
      const predicate =
        pending.tooLong || !Object.hasOwn(classes, name) ? undefined : classes[name];
      if (predicate === undefined) return "invalid";
      state.matched = state.matched.map((matched, index) =>
        matched || predicate(String.fromCharCode(codes[index]!)) ? 1 : 0,
      );
      state.previous = null;
      state.lead = "member";
      return "open";
    }
    Object.assign(state, pending.fallback);
    return fallback === "closed" ? "closed" : "open";
  }
  const result = feedCore(state, char, codes, true);
  if (result === "posix") {
    const fallback = { ...state, matched: [...state.matched] };
    literal(fallback, 91, codes);
    feedCore(fallback, ":", codes, false);
    state.posix = { name: "", tooLong: false, lastColon: false, fallback };
    return "open";
  }
  return result;
};
