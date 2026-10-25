import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import { createHarnessReleaseLedger } from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import { createHarnessReleaseSqliteStore } from "../../src/harnessReleases/HarnessReleaseSqliteStore.ts";
import type { HarnessReleaseSqliteDatabase } from "../../src/harnessReleases/HarnessReleaseSqliteStore.ts";
import { createHarnessProjectReleaseSqliteStore } from "../../src/harnessReleases/HarnessProjectReleaseSqliteStore.ts";
import { artifactDirectorySource } from "./prepareArtifact.ts";
import { writeClaudeReleaseVariantCatalog } from "./claudeReleaseVariants.ts";
import { openHarnessReleaseArtifact } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const decodeBaselinePin = Schema.decodeUnknownSync(
  Schema.Struct({
    identity: Schema.Struct({
      artifactRef: Schema.String,
      artifactHash: Sha256,
      sourceIdentity: Sha256,
    }),
    preparedModules: Schema.Record(
      Schema.String,
      Schema.Struct({
        component: Schema.Literals(["codex", "cli", "sdk"]),
        name: Schema.String,
        path: Schema.String,
        type: Schema.Literals(["js", "cjs", "text", "wasm"]),
        bytes: Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(0),
          Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
        ),
        sha256: Sha256,
      }),
    ),
  }),
  { onExcessProperty: "error", reportInput: false },
);

/** Publication consumes existing qualified ledger records; it never registers or promotes a pair. */
export interface PublishClaudeVariantsInput {
  readonly ledger: string;
  readonly projectId?: string;
  readonly baselineReleaseId: string;
  readonly hooksReleaseId: string;
  readonly baselineDirectory: string;
  readonly hooksDirectory: string;
  readonly baselinePin: string;
  readonly trustedComputer: { readonly sourceIdentity: string; readonly manifestSha256: string };
  readonly maxPreparedModuleBytes: number;
  readonly output: string;
  readonly expectedCliManifestSha256?: string;
}

export async function publishClaudeVariants(input: PublishClaudeVariantsInput) {
  const baselinePin = decodeBaselinePin(
    JSON.parse(await NodeFSP.readFile(input.baselinePin, "utf8")),
  );
  const database = new NodeSqlite.DatabaseSync(input.ledger, { readOnly: true });
  try {
    const storage: HarnessReleaseSqliteDatabase = {
      sql: {
        exec(query, ...bindings) {
          const statement = database.prepare(query);
          return statement.columns().length > 0
            ? statement.all(...bindings)
            : (statement.run(...bindings), []);
        },
      },
      transactionSync(operation) {
        database.exec("BEGIN");
        try {
          const result = operation();
          database.exec("COMMIT");
          return result;
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      },
    };
    const ledger = createHarnessReleaseLedger(
      input.projectId === undefined
        ? createHarnessReleaseSqliteStore(storage)
        : createHarnessProjectReleaseSqliteStore(storage, input.projectId),
    );
    const baseline = ledger.getArtifact("claude-code", input.baselineReleaseId);
    const hooks = ledger.getArtifact("claude-code", input.hooksReleaseId);
    if (!baseline || !hooks) throw new Error("CLAUDE_VARIANTS_LEDGER_RECORD_MISSING");
    const baselineSource = artifactDirectorySource(input.baselineDirectory);
    const hooksSource = artifactDirectorySource(input.hooksDirectory);
    if (input.expectedCliManifestSha256 !== undefined) {
      const prepared = await openHarnessReleaseArtifact(
        {
          artifactRef: hooks.artifactRef,
          artifactHash: hooks.artifactHash,
          sourceIdentity: hooks.sourceIdentity,
        },
        hooksSource,
      );
      const cliManifest = prepared.manifest.components.cli?.manifest;
      if (
        !cliManifest ||
        prepared.manifest.files[cliManifest]?.sha256 !== input.expectedCliManifestSha256
      )
        throw new Error("CLAUDE_VARIANTS_BUILD_MISMATCH");
    }
    return await writeClaudeReleaseVariantCatalog({
      catalog: {
        baseline: { variant: "baseline", fullArtifact: baseline },
        hooks: { variant: "hooks", fullArtifact: hooks },
      },
      ledger,
      source: {
        read(ref, path) {
          const source =
            ref === baseline.artifactRef
              ? baselineSource
              : ref === hooks.artifactRef
                ? hooksSource
                : undefined;
          if (!source) throw new Error("CLAUDE_VARIANTS_ARTIFACT_REF_MISMATCH");
          return source.read(ref, path);
        },
      },
      baselinePin,
      trustedComputer: input.trustedComputer,
      maxPreparedModuleBytes: input.maxPreparedModuleBytes,
      output: input.output,
    });
  } finally {
    database.close();
  }
}
