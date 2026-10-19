// @effect-diagnostics nodeBuiltinImport:off - inspect only this store's files, including pre-compilation type edges.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { expect, it } from "@effect/vitest";

it("keeps the owned store import graph acyclic, including type imports and re-exports", () => {
  const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
  const privateRoot = NodePath.join(root, "runStore");
  const files = [
    NodePath.join(root, "HarnessRunStore.ts"),
    NodePath.join(root, "HarnessRunStoreObject.ts"),
    ...NodeFS.readdirSync(privateRoot, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".ts"))
      .map((path) => NodePath.join(privateRoot, path)),
  ].sort();
  const owned = new Set(files);
  const edges = new Map<string, Set<string>>();
  for (const path of files) {
    const imports = new Set<string>();
    const add = (specifier: string) => {
      if (!specifier.startsWith(".")) return;
      const target = NodePath.resolve(NodePath.dirname(path), specifier);
      if (owned.has(target)) imports.add(target);
    };
    const scanner = createScanner(true, undefined, NodeFS.readFileSync(path, "utf8"));
    let previous: SyntaxKind = SyntaxKind.Unknown;
    let beforePrevious: SyntaxKind = SyntaxKind.Unknown;
    for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
      if (
        token === SyntaxKind.StringLiteral &&
        (previous === SyntaxKind.FromKeyword ||
          previous === SyntaxKind.ImportKeyword ||
          (previous === SyntaxKind.OpenParenToken && beforePrevious === SyntaxKind.ImportKeyword))
      ) {
        add(scanner.getTokenValue());
      }
      beforePrevious = previous;
      previous = token;
    }
    edges.set(path, imports);
  }
  const visited = new Set<string>();
  const active: string[] = [];
  const cycles: string[][] = [];
  const walk = (path: string) => {
    const index = active.indexOf(path);
    if (index !== -1) {
      cycles.push([...active.slice(index), path].map((file) => NodePath.relative(root, file)));
      return;
    }
    if (visited.has(path)) return;
    visited.add(path);
    active.push(path);
    for (const target of edges.get(path) ?? []) walk(target);
    active.pop();
  };
  for (const path of files) walk(path);
  expect(cycles).toEqual([]);
});
