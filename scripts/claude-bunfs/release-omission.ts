// @effect-diagnostics nodeBuiltinImport:off - hash build inputs and coverage evidence.
import * as NodeCrypto from "node:crypto";
import ts from "typescript-legacy";

export interface ReleaseCoverageCorpus {
  readonly schemaVersion: 1;
  readonly binarySha256: string;
  readonly provenance: readonly { readonly name: string; readonly sha256: string }[];
  readonly pending: readonly string[];
  /** Only inputs with an observed lazy initializer belong here. Eager inputs are never inferred cold. */
  readonly inputs: readonly { readonly inputPath: string; readonly initialized: boolean }[];
}

export interface ReleaseOmissionOptions {
  readonly configuration: {
    readonly name: string;
    readonly env: Readonly<Record<string, string | null>>;
    readonly settings: Readonly<Record<string, unknown>>;
  };
  readonly corpus?: ReleaseCoverageCorpus;
}

export interface OmittedReleaseChunk {
  readonly chunkId: string;
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
    readonly sha256: string;
    readonly provenance: ReleaseCoverageCorpus["provenance"];
    readonly pending: ReleaseCoverageCorpus["pending"];
  } | null;
  readonly chunks: readonly OmittedReleaseChunk[];
}

export const releaseSourceHash = (source: string) =>
  NodeCrypto.createHash("sha256").update(source).digest("hex");

/** Untrusted corpus files must fail closed rather than treating missing records as cold. */
export function parseReleaseCoverageCorpus(value: unknown): ReleaseCoverageCorpus {
  if (typeof value !== "object" || value === null) throw new Error("RELEASE_CORPUS_INVALID");
  const input = value as Record<string, unknown>;
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (
    input.schemaVersion !== 1 ||
    !hash(input.binarySha256) ||
    !Array.isArray(input.inputs) ||
    !Array.isArray(input.provenance) ||
    !input.provenance.length ||
    !Array.isArray(input.pending) ||
    input.pending.some((v) => typeof v !== "string")
  )
    throw new Error("RELEASE_CORPUS_INVALID");
  const seen = new Set<string>();
  const inputs = input.inputs.map((row: unknown) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("inputPath" in row) ||
      typeof row.inputPath !== "string" ||
      !row.inputPath ||
      !("initialized" in row) ||
      typeof row.initialized !== "boolean" ||
      seen.has(row.inputPath)
    )
      throw new Error("RELEASE_CORPUS_INVALID");
    seen.add(row.inputPath);
    return { inputPath: row.inputPath, initialized: row.initialized };
  });
  const provenance = input.provenance.map((row: unknown) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("name" in row) ||
      typeof row.name !== "string" ||
      !row.name ||
      !("sha256" in row) ||
      !hash(row.sha256)
    )
      throw new Error("RELEASE_CORPUS_INVALID");
    return { name: row.name, sha256: row.sha256 };
  });
  return {
    schemaVersion: 1,
    binarySha256: input.binarySha256,
    inputs,
    provenance,
    pending: input.pending as string[],
  };
}

/** Hoisted exports also fail when a cycle calls them before their module initializes. */
export function omittedModuleSource(source: string, chunk: OmittedReleaseChunk, commonJs: boolean) {
  const file = ts.createSourceFile(
    chunk.inputPath,
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
        throw new Error(`RELEASE_OMISSION_EXPORT_UNSUPPORTED: ${chunk.inputPath}`);
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
      else throw new Error(`RELEASE_OMISSION_EXPORT_UNSUPPORTED: ${chunk.inputPath}`);
    }
  }
  const detail = JSON.stringify({
    code: "RELEASE_CHUNK_OMITTED",
    chunkId: chunk.chunkId,
    inputPath: chunk.inputPath,
    tier: chunk.tier,
  });
  const failure = `const detail=${detail};const error=Object.assign(new Error("RELEASE_CHUNK_OMITTED: "+detail.chunkId+" ("+detail.inputPath+")"),detail,{name:"ReleaseChunkOmittedError"});try{globalThis[Symbol.for("signalbox.releaseChunkOmitted")]?.(detail)}finally{throw error}`;
  const bindings = [...names].map((name, i) => `v${i} as ${JSON.stringify(name)}`);
  const exports = commonJs
    ? ""
    : `${[...names].map((_, i) => `function v${i}(){return __signalboxOmitted()}`).join("\n")}export{${bindings.join(",")}};`;
  return `function __signalboxOmitted(){${failure}}${exports}__signalboxOmitted();${commonJs ? "module.exports={};" : ""}`;
}
