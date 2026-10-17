// @effect-diagnostics nodeBuiltinImport:off - compiler fixtures detect shared-store patches.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, test } from "vite-plus/test";
import { assertUnpatchedCompiler, compareDiagnostics, diagnostics } from "./typecheck-parity.ts";

const typeError =
  "src/file.ts(4,2): error TS2322: Type 'string' is not assignable to type 'number'.\n";
const effectError = "src/file.ts(9,3): error TS377033: Use the Effect clock. effect(globalDate)\n";

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
