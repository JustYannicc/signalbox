// @effect-diagnostics nodeBuiltinImport:off - compiler fixtures detect shared-store patches.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, test } from "vite-plus/test";
import {
  assertUnpatchedCompiler,
  compareDiagnostics,
  compilerProjects,
  diagnostics,
  runCompiler,
} from "./typecheck-parity.ts";

const typeError =
  "src/file.ts(4,2): error TS2322: Type 'string' is not assignable to type 'number'.\n";
const effectError = "src/file.ts(9,3): error TS377033: Use the Effect clock. effect(globalDate)\n";

test("parity retains both Cloud compiler configs after its declared codegen prerequisites", () => {
  const cloud = JSON.parse(
    NodeFS.readFileSync(new URL("../apps/cloud/package.json", import.meta.url), "utf8"),
  );
  expect(compilerProjects("apps/cloud", cloud.scripts.typecheck)).toEqual([
    "apps/cloud/tsconfig.json",
    "apps/cloud/tsconfig.infra.json",
  ]);
});

test("parity rejects unknown commands and the Cloud prerequisite in other workspaces", () => {
  expect(() => compilerProjects("apps/cloud", "node other-check.mjs && tsc-rs --noEmit")).toThrow(
    "Unrecognized typecheck",
  );
  expect(() => compilerProjects("apps/web", "node infra/syncProbe/prepare.mjs")).toThrow(
    "Unrecognized typecheck",
  );
  expect(() =>
    compilerProjects("apps/web", "node --experimental-strip-types infra/isolateProbe/prepare.ts"),
  ).toThrow("Unrecognized typecheck");
});

test("parity rejects same-version Effect patches through compiler symlinks", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compiler-patch-"));
  try {
    const binary = NodePath.join(directory, "tsc");
    const link = NodePath.join(directory, "linked-tsc");
    NodeFS.writeFileSync(binary, "Version 7.0.2");
    NodeFS.symlinkSync(binary, link);
    expect(() => assertUnpatchedCompiler(link)).not.toThrow();
    NodeFS.copyFileSync(binary, `${binary}.original`);
    expect(() => assertUnpatchedCompiler(binary)).toThrow("Effect patch backup");
    expect(() => assertUnpatchedCompiler(link)).toThrow("Effect patch backup");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

test("parity combines declared TypeScript with Effect diagnostics regardless of output order", () => {
  expect(
    compareDiagnostics(typeError, effectError + typeError, typeError + effectError).equal,
  ).toBe(true);
});

test("parity rejects added and missing diagnostics, including suggestions and severity changes", () => {
  expect(compareDiagnostics("", "", typeError).equal).toBe(false);
  expect(compareDiagnostics(typeError, typeError, "").equal).toBe(false);
  expect(compareDiagnostics("", effectError, "").equal).toBe(false);
  expect(compareDiagnostics("", effectError, effectError.replace("error", "warning")).equal).toBe(
    false,
  );
  expect(compareDiagnostics("", effectError.replace("error", "suggestion"), "").equal).toBe(false);
});

test("parity preserves multiline explanations, source locations and project errors", () => {
  const multiline = typeError.trimEnd() + "\n  The expected type comes from this declaration.\n";
  expect(diagnostics(multiline)[0]?.message).toContain(
    "The expected type comes from this declaration.",
  );
  expect(compareDiagnostics(typeError, "", typeError.replace("(4,2)", "(5,2)")).equal).toBe(false);
  expect(compareDiagnostics("error TS5083: Cannot read file 'missing.json'.\n", "", "").equal).toBe(
    false,
  );
});

test("parity normalizes Windows line endings before locating multiline diagnostics", () => {
  const unix = typeError + effectError;
  const windows = unix.replaceAll("\n", "\r\n");
  expect(compareDiagnostics(typeError, effectError, windows).equal).toBe(true);
  expect(diagnostics(windows)).toEqual(diagnostics(unix));
});

test("compiler parity checks composite projects with fresh build state on every run", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "composite-parity-"));
  try {
    const project = NodePath.join(directory, "tsconfig.json");
    const source = NodePath.join(directory, "fixture.ts");
    NodeFS.writeFileSync(
      project,
      JSON.stringify({ compilerOptions: { composite: true, noEmit: true }, files: ["fixture.ts"] }),
    );
    NodeFS.writeFileSync(source, "const value: number = 1;\n");
    const compiler = NodeURL.fileURLToPath(new URL("../node_modules/.bin/tsc-rs", import.meta.url));
    const clean = runCompiler(compiler, project);
    expect(clean.output).not.toContain("TS6379");
    expect(clean.status).toBe(0);
    NodeFS.writeFileSync(source, 'const value: number = "wrong";\n');
    const changed = runCompiler(compiler, project);
    expect(changed.status).not.toBe(0);
    expect(changed.output).toContain("TS2322");
    expect(NodeFS.readdirSync(directory).sort()).toEqual(["fixture.ts", "tsconfig.json"]);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
