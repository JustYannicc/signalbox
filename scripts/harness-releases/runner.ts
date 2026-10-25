import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { HarnessProvider } from "./discovery.ts";
import { assertFixtureUnchanged, freezeFixture, sha256, type FrozenFixture } from "./fixture.ts";
import {
  RELEASE_CRITERIA,
  verifyMeasurement,
  verifyReleaseCriteria,
  type ProofEnvironment,
  type ReleaseCriteriaAssessment,
} from "./measurement.ts";
import {
  assertReleaseSelection,
  freezeArtifact,
  newReleaseRunId,
  type ArtifactIdentity,
  type OfficialReleaseIdentity,
} from "./releaseIdentity.ts";
import { assertSourcesUnchanged, freezeSources, type SourceFreeze } from "./sourceFreeze.ts";
import { assertPathOutside, relativePathWithin } from "./pathContainment.ts";

export class PendingReleaseProof extends Error {}
export type GateStatus = "passed" | "pending" | "rejected";
export interface ReleaseBuild {
  readonly artifact: string;
  readonly extracted?: string;
}
export interface ScanAssessment {
  readonly status: GateStatus;
  readonly detail: string;
}
export interface ReleaseContext {
  readonly repository: string;
  readonly output: string;
  readonly runId: string;
  readonly identity: OfficialReleaseIdentity;
}
export interface ReleaseOperations {
  identity(provider: HarnessProvider, version: string): Promise<OfficialReleaseIdentity>;
  build(context: ReleaseContext): Promise<ReleaseBuild>;
  scan(context: ReleaseContext, build: ReleaseBuild): Promise<ScanAssessment>;
  packageFixture(context: ReleaseContext, build: ReleaseBuild): Promise<string>;
  prepareDeployment(context: ReleaseContext): Promise<void>;
  measure(
    context: ReleaseContext,
    fixture: string,
    environment: ProofEnvironment,
  ): Promise<unknown>;
  cleanup(context: ReleaseContext): Promise<void>;
  publish?(context: ReleaseContext): Promise<void>;
  assess?: typeof verifyReleaseCriteria;
  freeze?: typeof freezeSources;
}
interface StageRecord {
  readonly name: string;
  status: GateStatus;
  error?: string;
  sourceBefore?: string;
  sourceAfter?: string;
}
export interface ReleaseRunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly runKey: string;
  readonly provider: HarnessProvider;
  readonly version: string;
  readonly identity?: OfficialReleaseIdentity;
  readonly source?: SourceFreeze;
  readonly fixture?: FrozenFixture;
  readonly artifact?: ArtifactIdentity & { readonly ref: string };
  readonly candidateId?: string;
  readonly selection: "current" | "backfill";
  readonly status: "green" | "red" | "pending";
  readonly unchangedSource: GateStatus;
  readonly scan?: ScanAssessment;
  readonly environments: Partial<Record<ProofEnvironment, ReleaseCriteriaAssessment>>;
  readonly stages: ReadonlyArray<StageRecord>;
  readonly publication: "withheld" | "attempted" | "published";
}

export async function writeOnce(file: string, value: unknown) {
  await NodeFSP.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o444 });
}

function assessmentStatus(assessment: ReleaseCriteriaAssessment): GateStatus {
  if (
    assessment.checks.length !== RELEASE_CRITERIA.length ||
    new Set(assessment.checks.map((check) => check.name)).size !== RELEASE_CRITERIA.length ||
    RELEASE_CRITERIA.some((name) => !assessment.checks.some((check) => check.name === name))
  )
    throw new Error("RELEASE_CRITERIA_INCOMPLETE");
  if (assessment.checks.some((check) => check.status === "rejected")) return "rejected";
  const metrics = (["moduleBytes", "bootTimeMs", "peakHeapBytes"] as const).map(
    (name) => assessment.metrics[name],
  );
  for (const metric of metrics) {
    if (!metric) throw new Error("RELEASE_METRIC_MISSING");
    if (metric.state === "measured" && (!Number.isFinite(metric.value) || metric.value < 0))
      throw new Error("RELEASE_METRIC_INVALID");
  }
  return assessment.checks.every((check) => check.status === "passed") &&
    metrics.every((metric) => metric.state === "measured")
    ? "passed"
    : "pending";
}

/** The operation boundary lets synthetic tests exercise failures without building or deploying. */
export async function runRelease(
  options: {
    repository: string;
    output: string;
    provider: HarnessProvider;
    version: string;
    runKey?: string;
    selection?: "current" | "backfill";
  },
  operations: ReleaseOperations,
): Promise<ReleaseRunResult> {
  assertReleaseSelection(options.provider, options.version);
  const runKey = `harness-release:${options.provider}:${options.version}`;
  if (options.runKey !== undefined && options.runKey !== runKey)
    throw new Error("RELEASE_RUN_KEY_MISMATCH");
  const requestedOutput = NodePath.resolve(options.output);
  const repository = await NodeFSP.realpath(options.repository);
  // Evidence and build caches must never become source inputs, even through a symlink.
  const parent = await NodeFSP.realpath(NodePath.dirname(requestedOutput));
  assertPathOutside(repository, parent, "RELEASE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  const output = NodePath.join(parent, NodePath.basename(requestedOutput));
  await NodeFSP.mkdir(output);
  const runId = newReleaseRunId();
  const selection = options.selection ?? "current";
  const stages: StageRecord[] = [];
  const environments: ReleaseRunResult["environments"] = {};
  const freeze = operations.freeze ?? freezeSources;
  let source: SourceFreeze | undefined;
  let identity: OfficialReleaseIdentity | undefined;
  let fixture: FrozenFixture | undefined;
  let fixtureDirectory: string | undefined;
  let artifact: ReleaseRunResult["artifact"];
  let candidateId: string | undefined;
  let context: ReleaseContext | undefined;
  let scan: ScanAssessment | undefined;
  const sourceState: { status: GateStatus } = { status: "pending" };
  let publication: ReleaseRunResult["publication"] = "withheld";
  const assertArtifact = async () => {
    if (
      artifact &&
      (await freezeArtifact(NodePath.join(output, artifact.ref))).sha256 !== artifact.sha256
    )
      throw new Error("RELEASE_ARTIFACT_CHANGED");
  };
  const stage = async <T>(name: string, action: () => Promise<T>, recovery = false) => {
    const record: StageRecord = { name, status: "pending" };
    stages.push(record);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      try {
        const before = await freeze(repository);
        if (!source) {
          await writeOnce(NodePath.join(output, "source-freeze.json"), before);
          source = before;
        }
        record.sourceBefore = before.sha256;
        assertSourcesUnchanged(source, before);
      } catch (error) {
        if (!recovery) throw error;
        sourceState.status = "rejected";
        record.error = error instanceof Error ? error.message : String(error);
      }
      try {
        if (fixture && fixtureDirectory)
          assertFixtureUnchanged(fixture, await freezeFixture(fixtureDirectory));
      } catch (error) {
        if (!recovery) throw error;
        record.error = [record.error, error instanceof Error ? error.message : String(error)]
          .filter(Boolean)
          .join("; ");
      }
      if (!recovery) await assertArtifact();
      outcome = { ok: true, value: await action() };
      record.status = record.error ? "rejected" : "passed";
    } catch (error) {
      record.status = error instanceof PendingReleaseProof ? "pending" : "rejected";
      record.error = error instanceof Error ? error.message : String(error);
      outcome = { ok: false, error };
    }
    let artifactFailed = false;
    try {
      const after = await freeze(repository);
      record.sourceAfter = after.sha256;
      if (!source) throw new Error("RELEASE_SOURCE_FREEZE_MISSING");
      assertSourcesUnchanged(source, after);
      if (sourceState.status !== "rejected") sourceState.status = "passed";
    } catch (error) {
      sourceState.status = "rejected";
      record.status = "rejected";
      const detail = error instanceof Error ? error.message : String(error);
      record.error = [record.error, detail].filter(Boolean).join("; ");
    }
    try {
      await assertArtifact();
    } catch (error) {
      artifactFailed = true;
      record.status = "rejected";
      record.error = [record.error, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join("; ");
    }
    let fixtureFailed = false;
    try {
      if (fixture && fixtureDirectory)
        assertFixtureUnchanged(fixture, await freezeFixture(fixtureDirectory));
    } catch (error) {
      fixtureFailed = true;
      record.status = "rejected";
      record.error = [record.error, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join("; ");
    }
    await writeOnce(
      NodePath.join(output, `${String(stages.length).padStart(2, "0")}-${name}.json`),
      record,
    );
    if (sourceState.status === "rejected" || artifactFailed || fixtureFailed)
      throw new Error(record.error);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
  try {
    identity = await stage("identity", async () => {
      const resolved = await operations.identity(options.provider, options.version);
      if (resolved.provider !== options.provider || resolved.version !== options.version)
        throw new Error("RELEASE_IDENTITY_SELECTION_MISMATCH");
      await writeOnce(NodePath.join(output, "identity.json"), resolved);
      return resolved;
    });
    context = { repository, output, runId, identity };
    const current = context;
    const built = await stage("build", () => operations.build(current));
    const artifactRef = relativePathWithin(
      output,
      await NodeFSP.realpath(built.artifact),
      "RELEASE_ARTIFACT_OUTSIDE_RUN",
    );
    artifact = {
      ...(await stage("freeze-artifact", () => freezeArtifact(built.artifact))),
      ref: artifactRef,
    };
    await stage("scan", async () => {
      const assessment = await operations.scan(current, built);
      scan = assessment;
      await writeOnce(NodePath.join(output, "scan-assessment.json"), assessment);
      if (assessment.status === "rejected") throw new Error("RELEASE_SCAN_REJECTED");
      if (assessment.status === "pending")
        throw new PendingReleaseProof(assessment.detail || "The release scan is incomplete.");
      return assessment;
    });
    const packagedFixtureDirectory = await stage("package-fixture", () =>
      operations.packageFixture(current, built),
    );
    fixtureDirectory = packagedFixtureDirectory;
    relativePathWithin(
      output,
      await NodeFSP.realpath(packagedFixtureDirectory),
      "RELEASE_FIXTURE_OUTSIDE_RUN",
    );
    fixture = await stage("freeze-fixture", () => freezeFixture(packagedFixtureDirectory));
    await writeOnce(NodePath.join(output, "fixture.json"), fixture);
    candidateId = `${options.provider}:${options.version}:${sha256(
      JSON.stringify({
        official: identity.sha256,
        source: source!.sha256,
        artifact: artifact.sha256,
        fixture: fixture.sha256,
      }),
    )}`;
    const frozen = fixture;
    const measurementIds = new Set<string>();
    await stage("prepare-deployment", () => operations.prepareDeployment(current));
    for (const environment of ["local-workerd", "deployed"] as const) {
      environments[environment] = await stage(`measure-${environment}`, async () => {
        assertFixtureUnchanged(frozen, await freezeFixture(packagedFixtureDirectory));
        try {
          const raw = await operations.measure(current, packagedFixtureDirectory, environment);
          // Only newly returned evidence is accepted. Prior files are never loaded by the runner.
          await writeOnce(NodePath.join(output, `${environment}.json`), raw);
          const verified = verifyMeasurement(frozen, raw, environment);
          if (measurementIds.has(verified.runId)) throw new Error("RELEASE_PROOF_REUSED_RUN_ID");
          measurementIds.add(verified.runId);
          const assessment = (operations.assess ?? verifyReleaseCriteria)(frozen, raw, environment);
          environments[environment] = assessment;
          await writeOnce(NodePath.join(output, `${environment}-criteria.json`), assessment);
          if (assessmentStatus(assessment) === "rejected")
            throw new Error("RELEASE_CRITERION_REJECTED");
          return assessment;
        } finally {
          assertFixtureUnchanged(frozen, await freezeFixture(packagedFixtureDirectory));
        }
      });
    }
  } catch (error) {
    // Some failures occur between stages, so preserve their disposition as well.
    stages.push({
      name: "outcome",
      status: error instanceof PendingReleaseProof ? "pending" : "rejected",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (context) {
      try {
        await stage("cleanup", () => operations.cleanup(context!), true);
      } catch {
        /* Recorded by stage. */
      }
    }
  }
  const rejected =
    sourceState.status === "rejected" || stages.some((item) => item.status === "rejected");
  const complete =
    !rejected &&
    sourceState.status === "passed" &&
    scan?.status === "passed" &&
    stages.every((item) => item.status === "passed") &&
    ["local-workerd", "deployed"].every((name) => {
      const assessment = environments[name as ProofEnvironment];
      return assessment !== undefined && assessmentStatus(assessment) === "passed";
    });
  let status: ReleaseRunResult["status"] = rejected ? "red" : complete ? "green" : "pending";
  if (status === "green" && context && selection === "current" && operations.publish) {
    publication = "attempted";
    try {
      await stage("publish", () => operations.publish!(context!));
      publication = "published";
    } catch {
      status = "red";
    }
  }
  const result: ReleaseRunResult = {
    schemaVersion: 1,
    runId,
    runKey,
    provider: options.provider,
    version: options.version,
    ...(identity ? { identity } : {}),
    ...(source ? { source } : {}),
    ...(fixture ? { fixture } : {}),
    ...(artifact ? { artifact } : {}),
    ...(candidateId ? { candidateId } : {}),
    selection,
    status,
    unchangedSource: sourceState.status,
    ...(scan ? { scan } : {}),
    environments,
    stages,
    publication,
  };
  await writeOnce(NodePath.join(output, "result.json"), result);
  return result;
}
