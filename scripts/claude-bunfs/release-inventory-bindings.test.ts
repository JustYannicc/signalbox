import { describe, expect, it } from "@effect/vitest";
import ts from "typescript-legacy";
import { expressionPath, guardedBunUseLocations, isGuarded } from "./release-inventory-bindings.ts";
import type { ScannableModule } from "./release-inventory-imports.ts";
import type { BunApiInventory } from "./bun-api-inventory.ts";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("fixture.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function guardForCall(source: string, expression: string, path: ReadonlyArray<string>): boolean {
  const file = parse(source);
  let result = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === expression) {
      const access = node.expression;
      const actual = expressionPath(access);
      result =
        actual?.path.join(".") === path.join(".") &&
        isGuarded(file, access, actual.root, actual.path, "call");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

function bunUseIsGuarded(source: string, path: string, access: "read" | "call" = "call"): boolean {
  const offset = source.lastIndexOf("Bun.");
  const module: ScannableModule = {
    index: 0,
    key: "fixture.js",
    name: "fixture.js",
    loader: 1,
    bytes: source.length,
    source,
  };
  const inventory: BunApiInventory = {
    members: [
      { path, occurrences: [{ module: module.name, offset, line: 1, column: offset + 1, access }] },
    ],
    dynamicAccesses: [],
  };
  return guardedBunUseLocations([module], inventory).has(`${module.name}\0${offset}`);
}

describe("release inventory capability guards", () => {
  it("uses the exact branch polarity and requires every OR path to prove availability", () => {
    expect(guardForCall('if (typeof Bun.foo === "function") Bun.foo();', "Bun.foo", ["foo"])).toBe(
      true,
    );
    expect(guardForCall('if (typeof Bun.foo !== "function") Bun.foo();', "Bun.foo", ["foo"])).toBe(
      false,
    );
    expect(
      guardForCall('if (typeof Bun.foo !== "function") {} else Bun.foo();', "Bun.foo", ["foo"]),
    ).toBe(true);
    expect(
      guardForCall('if (typeof Bun.foo === "function" || fallback) Bun.foo();', "Bun.foo", ["foo"]),
    ).toBe(false);
    expect(
      guardForCall('if (typeof Bun.foo === "function" && fallback) Bun.foo();', "Bun.foo", ["foo"]),
    ).toBe(true);
  });

  it("does not infer a member guard from an optional receiver or a different leaf", () => {
    expect(guardForCall("Bun?.foo();", "Bun?.foo", ["foo"])).toBe(false);
    expect(guardForCall("Bun.foo?.();", "Bun.foo", ["foo"])).toBe(true);
    expect(
      guardForCall('if (typeof Bun.foo === "function") Bun.foo.bar();', "Bun.foo.bar", [
        "foo",
        "bar",
      ]),
    ).toBe(false);
    expect(guardForCall("fs.foo()?.();", "fs.foo", ["foo"])).toBe(false);
  });

  it("requires a guard and use to resolve to the same lexical binding", () => {
    expect(
      guardForCall(
        `
import * as fs from "node:fs";
if (typeof fs.newApi === "function") {
  const fs = os;
  fs.newApi();
}
`,
        "fs.newApi",
        ["newApi"],
      ),
    ).toBe(false);
  });

  it("matches the Bun inventory leaf at the occurrence offset", () => {
    const source = 'if (typeof Bun.foo === "function") Bun.foo.bar();';
    expect(bunUseIsGuarded(source, "foo.bar")).toBe(false);
  });
});
