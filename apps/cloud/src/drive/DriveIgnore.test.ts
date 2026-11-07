import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import ignore from "ignore";

import { IgnoreEvaluationState, beginIgnoreEvaluation, stepIgnoreRules } from "./DriveIgnore.ts";

const encoder = new TextEncoder();
const encodeState = Schema.encodeSync(Schema.fromJsonString(IgnoreEvaluationState));
const decodeState = Schema.decodeSync(Schema.fromJsonString(IgnoreEvaluationState));

const admitted = (rules: string, path: string, directory: boolean) => {
  const matcher = ignore({ ignorecase: false }).add(rules);
  for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
    const parent = path.slice(0, end + 1).replace(/[\\*?[\]#! ]/gu, "\\$&");
    matcher.add({ pattern: `!/${parent}` });
  }
  const { ignored, unignored } = matcher.test(`${path}${directory ? "/" : ""}`);
  return { ignored, unignored };
};

const evaluate = (rules: string, path: string, directory = false, quantum = 7) => {
  const bytes = encoder.encode(rules);
  let state = beginIgnoreEvaluation();
  let largest = 0;
  for (let offset = 0; offset < bytes.length || offset === 0; offset += quantum) {
    const chunk = bytes.subarray(offset, offset + quantum);
    const previous = encodeState(state);
    const result = stepIgnoreRules({
      state,
      bytes: chunk,
      sourceEnded: offset + quantum >= bytes.length,
      path,
      directory,
    });
    expect(encodeState(state)).toBe(previous);
    const serialized = encodeState(result.state);
    largest = Math.max(largest, serialized.length);
    state = decodeState(serialized);
  }
  return { state, largest };
};

describe("persisted ignore rule evaluation", () => {
  it("matches node-ignore after DFS admits proper parents", () => {
    const patterns = [
      "",
      "# comment",
      "!",
      "  ",
      "a",
      "a/",
      "/a",
      "/a/",
      "a/*",
      "a/**",
      "a/**/",
      "a/**/b",
      "**/a",
      "/**/a",
      "**/**/a",
      "a/**/**/b",
      "a/**/**/",
      "*",
      "**",
      "***",
      "?",
      "a?",
      "a*",
      "*a",
      "a*b",
      "a/***",
      "a/***/b",
      "a//b",
      "a/../b",
      "[ab]",
      "[!ab]",
      "[^ab]",
      "[]ab]",
      "[a-c]",
      "[c-a]",
      "[a-]",
      "[-a]",
      "[a\\-c]",
      "[[:alpha:]]",
      "[[:digit:]]",
      "[[:bogus:]]",
      "[[:alpha]]",
      "[a[:digit:]c]",
      "[a/b]",
      "[",
      "[abc",
      "\\[a]",
      "\\!a",
      "\\#a",
      "\\*",
      "a\\?",
      "a\\/b",
      "a\\/",
      "a ",
      "a\\ ",
      "a\\  ",
      "a\\\\ ",
      "a\t",
      "a\r",
      "a\r\r",
      "a \r ",
      "\uFEFFa",
      "\uFEFF!a",
      "\uFEFF#comment",
      "!a",
      "a\n!a",
      "!a\na",
      "a/\n!b",
      "é",
      "😀",
      "?😀",
      "[é]",
      "[😀]",
      "a\r\nb\n!a",
      "a\\\\\\",
      "a\\\\",
    ];
    const paths = [
      "a",
      "b",
      "c",
      "a.txt",
      "a ",
      "a\t",
      "a\r",
      "!a",
      "#a",
      "*",
      "[a]",
      "é",
      "😀",
      "x😀",
      "x/a",
      "a/b",
      "a/x/b",
      "a/b/c",
      "x/a/b",
      "a/1",
      "a/-",
      "a/é",
    ];
    for (const rules of patterns)
      for (const path of paths)
        for (const directory of [false, true])
          expect(
            evaluate(rules, path, directory).state.test,
            JSON.stringify({ rules, path, directory }),
          ).toEqual(admitted(rules, path, directory));
  });

  it("keeps last-rule decisions through empty chunks, CRLF, BOM, and UTF-8 boundaries", () => {
    for (const quantum of [1, 2, 3, 64 * 1024]) {
      const result = evaluate(
        "\uFEFF# ignored\r\n*.txt\r\n!café.txt\r\ncafé.txt\r\n!café.txt",
        "café.txt",
        false,
        quantum,
      );
      expect(result.state.test).toEqual({ ignored: false, unignored: true });
      expect(result.state.byteOffset).toBe(
        encoder.encode("\uFEFF# ignored\r\n*.txt\r\n!café.txt\r\ncafé.txt\r\n!café.txt").length,
      );
      expect(result.state.done).toBe(true);
    }
    const state = beginIgnoreEvaluation();
    expect(
      stepIgnoreRules({
        state,
        bytes: new Uint8Array(),
        sourceEnded: false,
        path: "a",
        directory: false,
      }).done,
    ).toBe(false);
    expect(evaluate("#empty\n\n", "a").state.test).toEqual({ ignored: false, unignored: false });
  });

  it("agrees on combinations of wildcard, class, anchor, escape, and negation tokens", () => {
    const tokens = [
      "a",
      "b",
      "*",
      "**",
      "***",
      "?",
      "[ab]",
      "[!ab]",
      "[a-c]",
      "[[:digit:]]",
      "\\*",
      "\\?",
      "\\[",
      "\\]",
      "\\a",
      "\\ ",
      " ",
      "/",
      "/**/",
      "[",
      "[a-",
      "[[:alpha]]",
    ];
    const paths = [
      "a",
      "ab",
      "b",
      "a b",
      "*",
      "?",
      "[a]",
      "a]",
      "a/b",
      "a/ab",
      "a/x/b",
      "b/a",
      "a\nb",
      "a\n/b",
      "a\u2028/b",
      "😀/a",
    ];
    let seed = 812;
    const next = (maximum: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % maximum;
    };
    for (let index = 0; index < 500; index++) {
      const rule = `${next(3) === 0 ? "!" : ""}${Array.from({ length: next(5) + 1 }, () => tokens[next(tokens.length)]).join("")}`;
      const rules = index % 2 === 0 ? `a\n${rule}` : `${rule}\n!b`;
      for (const path of paths)
        for (const directory of [false, true])
          expect(
            evaluate(rules, path, directory, 11).state.test,
            JSON.stringify({ rules, path, directory }),
          ).toEqual(admitted(rules, path, directory));
    }
  });

  it("streams files and single rules above former caps with a bounded checkpoint", () => {
    const rules = `a\n!a\n${"# comment\n".repeat(70_000)}${"*".repeat(600_000)}a\n!b`;
    const result = evaluate(rules, "a", false, 64 * 1024);
    expect(result.state.test).toEqual({ ignored: true, unignored: false });
    expect(result.state.byteOffset).toBe(encoder.encode(rules).length);
    expect(result.largest).toBeLessThan(4_096);
  });

  it("streams huge classes, whitespace, and POSIX lookahead without keeping their text", () => {
    const fixtures = [
      `[${"z".repeat(150_000)}a]`,
      `[!${"z".repeat(150_000)}]`,
      `[[:${"z".repeat(150_000)}:]]`,
      `[[:${"z".repeat(150_000)}]]`,
      `a${" ".repeat(150_000)}`,
      `a\\${" ".repeat(150_000)}`,
      `a${"\r".repeat(150_000)}`,
    ];
    for (const rules of fixtures) {
      const result = evaluate(rules, "a", false, 64 * 1024);
      expect(result.state.test).toEqual(admitted(rules, "a", false));
      expect(result.largest).toBeLessThan(4_096);
    }
  });
});
