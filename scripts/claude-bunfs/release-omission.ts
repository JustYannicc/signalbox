// @effect-diagnostics nodeBuiltinImport:off - hash build inputs and coverage evidence.
import * as NodeCrypto from "node:crypto";
import ts from "typescript-legacy";
import {
  RELEASE_MODULE_OMITTED_CODE,
  RELEASE_MODULE_OMITTED_REPORTER_KEY,
  type ReleaseModuleOmittedEvent,
  type ReleaseOmissionConfiguration,
} from "@t3tools/contracts/harnessReleaseOmission";

/** Pinned to one binary. Only explicitly cold lazy JS initializers count; missing inputs stay bundled. */
export interface ReleaseCoverageCorpus {
  readonly schemaVersion: 1;
  /** Coverage rows are valid only for this exact provider release binary. */
  readonly binarySha256: string;
  readonly provenance: readonly { readonly name: string; readonly sha256: string }[];
  readonly pending: readonly string[];
  /** Only observed cold, lazy JavaScript inputs may be omitted; absent inputs remain bundled. */
  readonly inputs: readonly { readonly inputPath: string; readonly initialized: boolean }[];
}

export interface ReleaseOmissionOptions {
  readonly configuration: ReleaseOmissionConfiguration;
  readonly corpus?: ReleaseCoverageCorpus;
}

export interface OmittedReleaseModule {
  readonly inputPath: string;
  readonly tier: "configuration" | "corpus";
  readonly sourceBytes: number;
  readonly sourceSha256: string;
}

export interface ReleaseOmissionManifest {
  readonly schemaVersion: 1;
  readonly configuration: ReleaseOmissionOptions["configuration"];
  readonly configurationReplacements: Readonly<Record<string, number>>;
  readonly configurationRemoved: readonly string[];
  readonly corpus: {
    readonly binarySha256: ReleaseCoverageCorpus["binarySha256"];
    readonly sha256: string;
    readonly provenance: ReleaseCoverageCorpus["provenance"];
    readonly pending: ReleaseCoverageCorpus["pending"];
  } | null;
  readonly omittedModules: readonly OmittedReleaseModule[];
  /** Worker coverage is pending; these inputs stay hot regardless of the main corpus. */
  readonly retainedInputs?: { readonly worker: readonly string[] };
}

export const releaseSourceHash = (source: string) =>
  NodeCrypto.createHash("sha256").update(source).digest("hex");

/** Untrusted corpus files must fail closed rather than treating missing records as cold. */
export function parseReleaseCoverageCorpus(value: unknown): ReleaseCoverageCorpus {
  const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  if (!isRecord(value)) throw new Error("RELEASE_CORPUS_INVALID");
  const input = value;
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (
    input.schemaVersion !== 1 ||
    !hash(input.binarySha256) ||
    !Array.isArray(input.inputs) ||
    !Array.isArray(input.provenance) ||
    !input.provenance.length ||
    !Array.isArray(input.pending)
  )
    throw new Error("RELEASE_CORPUS_INVALID");
  const pending = input.pending.filter((item): item is string => typeof item === "string");
  if (pending.length !== input.pending.length) throw new Error("RELEASE_CORPUS_INVALID");
  const seen = new Set<string>();
  const inputs = input.inputs.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.inputPath !== "string" ||
      !row.inputPath ||
      typeof row.initialized !== "boolean" ||
      seen.has(row.inputPath)
    )
      throw new Error("RELEASE_CORPUS_INVALID");
    seen.add(row.inputPath);
    return { inputPath: row.inputPath, initialized: row.initialized };
  });
  const provenance = input.provenance.map((row: unknown) => {
    if (!isRecord(row) || typeof row.name !== "string" || !row.name || !hash(row.sha256))
      throw new Error("RELEASE_CORPUS_INVALID");
    return { name: row.name, sha256: row.sha256 };
  });
  return {
    schemaVersion: 1,
    binarySha256: input.binarySha256,
    inputs,
    provenance,
    pending,
  };
}

/** Hoisted exports also fail when a cycle calls them before their module initializes. */
export function omittedModuleSource(
  source: string,
  module: OmittedReleaseModule,
  commonJs: boolean,
) {
  const file = ts.createSourceFile(
    module.inputPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set<string>();
  const collect = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else
      for (const element of name.elements) if (ts.isBindingElement(element)) collect(element.name);
  };
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      // An unsupported namespace must fail the build before any artifact is published.
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause))
        throw new Error(`RELEASE_OMISSION_EXPORT_UNSUPPORTED: ${module.inputPath}`);
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    } else if (ts.isExportAssignment(statement)) names.add("default");
    else if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        names.add("default");
      else if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) collect(declaration.name);
      else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      )
        names.add(statement.name.text);
      else throw new Error(`RELEASE_OMISSION_EXPORT_UNSUPPORTED: ${module.inputPath}`);
    }
  }
  const detail = {
    code: RELEASE_MODULE_OMITTED_CODE,
    inputPath: module.inputPath,
    tier: module.tier,
  } satisfies ReleaseModuleOmittedEvent;
  const detailSource = JSON.stringify(detail);
  const reporterKey = JSON.stringify(RELEASE_MODULE_OMITTED_REPORTER_KEY);
  const errorCode = JSON.stringify(`${RELEASE_MODULE_OMITTED_CODE}: `);
  const failure = [
    `const detail=${detailSource};`,
    `const error=Object.assign(new Error(${errorCode}+detail.inputPath),detail,{name:"ReleaseModuleOmittedError"});`,
    `try{globalThis[Symbol.for(${reporterKey})]?.(detail)}finally{throw error}`,
  ].join("");
  const bindings = [...names].map((name, i) => `v${i} as ${JSON.stringify(name)}`);
  const exports = commonJs
    ? ""
    : `${[...names].map((_, i) => `function v${i}(){return __signalboxOmitted()}`).join("\n")}export{${bindings.join(",")}};`;
  return `function __signalboxOmitted(){${failure}}${exports}__signalboxOmitted();${commonJs ? "module.exports={};" : ""}`;
}
