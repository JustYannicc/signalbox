// @effect-diagnostics nodeBuiltinImport:off - hashes normalized module keys for path-free proof evidence.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  compareFixtureInventories,
  validateFixtureInventory,
  type FixtureInventory,
} from "./prove-inventory.ts";

const GRAPH_FIELDS = [
  "container",
  "offsetsSize",
  "offset",
  "length",
  "byteCount",
  "flags",
  "entry",
  "recordSize",
] as const;
const MODULE_FIELDS = ["index", "name", "key", "encoding", "loader", "format", "side"] as const;

type ProofModule = {
  index: number;
  name: string;
  key: string;
  encoding: number;
  loader: number;
  format: number;
  side: number;
  contentsSha256: string;
};

type ProofResult = {
  version: string;
  platform: string;
  binaryUrl: string;
  binaryBytes: number;
  serializedGraphSha256: string;
  graph: Record<string, unknown>;
  modules: ProofModule[];
};

type ProofObservation = {
  result: ProofResult;
  inventory: FixtureInventory | undefined;
};

export type ProofManifest = {
  binary: { bytes: number; sha256?: string };
  serializedGraph: { sha256: string };
  graph: Record<string, unknown>;
  modules: Record<string, unknown>[];
};

export type ProofCase = {
  version: string;
  platform: string;
  manifest: ProofManifest;
};

type ProofSummary = {
  binaryBytes: number;
  serializedGraphSha256: string;
  graph: Record<string, unknown>;
  modules: {
    index: number;
    name: string;
    normalizedKeySha256: string;
    encoding: number;
    loader: number;
    format: number;
    side: number;
    contentsSha256: string;
  }[];
};

type MeasurementSummary = ProofSummary & { inventory: FixtureInventory | null };

export type ComparisonEvidence = {
  schemaVersion: 1;
  status: "passed" | "failed";
  environments: { local: "local-workerd"; deployed: "deployed" };
  cases: {
    version: string;
    platform: string;
    manifest: ProofSummary;
    local?: MeasurementSummary;
    deployed?: MeasurementSummary;
    mismatches: string[];
  }[];
  mismatches: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function validateManifest(value: unknown, label: string): ProofManifest {
  if (
    !isRecord(value) ||
    !isRecord(value.binary) ||
    !isRecord(value.serializedGraph) ||
    !isRecord(value.graph) ||
    !Array.isArray(value.modules)
  ) {
    throw new Error(`${label} is not an extractor manifest.`);
  }
  requireNumber(value.binary.bytes, `${label} binary.bytes`);
  if (!isHash(value.serializedGraph.sha256)) {
    throw new Error(`${label} has an invalid serialized graph SHA-256.`);
  }
  for (const field of GRAPH_FIELDS) {
    const fieldValue = value.graph[field];
    if (field === "flags" && value.graph.offsetsSize === 24 && fieldValue === undefined) continue;
    if (field === "container") {
      if (typeof fieldValue !== "string")
        throw new Error(`${label} graph.container must be a string.`);
    } else requireNumber(fieldValue, `${label} graph.${field}`);
  }

  for (let index = 0; index < value.modules.length; index++) {
    const module = value.modules[index];
    if (!isRecord(module) || !isRecord(module.artifacts) || !isRecord(module.artifacts.contents)) {
      throw new Error(`${label} module ${index} has no contents artifact.`);
    }
    for (const field of MODULE_FIELDS) {
      const fieldValue = module[field];
      const valid =
        field === "name" || field === "key"
          ? typeof fieldValue === "string"
          : typeof fieldValue === "number" && Number.isSafeInteger(fieldValue);
      if (!valid) throw new Error(`${label} module ${index}.${field} is invalid.`);
    }
    if ((module.key as string).startsWith("/")) {
      throw new Error(`${label} module ${index} key is not normalized.`);
    }
    if (!isHash(module.artifacts.contents.sha256)) {
      throw new Error(`${label} module ${index} has an invalid contents SHA-256.`);
    }
  }

  return value as unknown as ProofManifest;
}

function isProofResult(value: unknown): value is ProofResult {
  if (!isRecord(value) || !isRecord(value.graph) || !Array.isArray(value.modules)) return false;
  if (
    typeof value.version !== "string" ||
    typeof value.platform !== "string" ||
    typeof value.binaryUrl !== "string" ||
    typeof value.binaryBytes !== "number" ||
    !Number.isSafeInteger(value.binaryBytes) ||
    value.binaryBytes < 0 ||
    !isHash(value.serializedGraphSha256)
  ) {
    return false;
  }
  return value.modules.every(
    (module) =>
      isRecord(module) &&
      typeof module.index === "number" &&
      Number.isSafeInteger(module.index) &&
      typeof module.name === "string" &&
      typeof module.key === "string" &&
      typeof module.encoding === "number" &&
      Number.isSafeInteger(module.encoding) &&
      typeof module.loader === "number" &&
      Number.isSafeInteger(module.loader) &&
      typeof module.format === "number" &&
      Number.isSafeInteger(module.format) &&
      typeof module.side === "number" &&
      Number.isSafeInteger(module.side) &&
      isHash(module.contentsSha256),
  );
}

function expectedModules(item: ProofCase) {
  return item.manifest.modules.map((module) => {
    const artifacts = module.artifacts as Record<string, unknown>;
    const contents = artifacts.contents as Record<string, unknown>;
    return {
      index: module.index as number,
      name: module.name as string,
      key: module.key as string,
      encoding: module.encoding as number,
      loader: module.loader as number,
      format: module.format as number,
      side: module.side as number,
      contentsSha256: contents.sha256 as string,
    };
  });
}

function proofResult(
  measurement: unknown,
  item: ProofCase,
  environment: "local" | "deployed",
  mismatches: string[],
): ProofObservation | undefined {
  const label = `${environment} ${item.version}/${item.platform}`;
  if (!isRecord(measurement) || !Array.isArray(measurement.rows)) {
    mismatches.push(`${label}: measurement has no rows.`);
    return undefined;
  }
  const expectedEnvironment = environment === "local" ? "local-workerd" : "deployed";
  if (measurement.environment !== expectedEnvironment) {
    mismatches.push(`${label}: measurement environment is unexpected.`);
  }
  if (Array.isArray(measurement.verificationErrors) && measurement.verificationErrors.length > 0) {
    mismatches.push(`${label}: measurement reported verification errors.`);
  }

  const path = `/proof?version=${item.version}&platform=${item.platform}`;
  const matches = measurement.rows.filter((row) => isRecord(row) && row.path === path);
  if (matches.length !== 1) {
    mismatches.push(`${label}: expected one measurement row, found ${matches.length}.`);
    return undefined;
  }
  const row = matches[0];
  if (!isRecord(row)) return undefined;
  if (row.error !== undefined && row.error !== null) {
    mismatches.push(`${label}: measurement transport failed.`);
    return undefined;
  }
  if (!isRecord(row.response)) {
    mismatches.push(`${label}: measurement has no response.`);
    return undefined;
  }
  if (row.response.error !== undefined && row.response.error !== null) {
    mismatches.push(`${label}: facet returned an error.`);
    return undefined;
  }
  if (row.response.status !== 200) {
    mismatches.push(`${label}: facet response status was not 200.`);
    return undefined;
  }
  if (row.response.target !== "facet") {
    mismatches.push(`${label}: response target was not a facet.`);
  }
  const inventory = validateFixtureInventory(row.inventory, label);
  mismatches.push(...inventory.mismatches);
  if (!isProofResult(row.response.result)) {
    mismatches.push(`${label}: facet result does not match the proof contract.`);
    return undefined;
  }
  return { result: row.response.result, inventory: inventory.inventory };
}

function compareResult(item: ProofCase, result: ProofResult, label: string, mismatches: string[]) {
  if (!NodeUtil.isDeepStrictEqual(result.graph, item.manifest.graph)) {
    mismatches.push(`${label}: graph differs from the extracted artifact.`);
  }
  if (result.serializedGraphSha256 !== item.manifest.serializedGraph.sha256) {
    mismatches.push(`${label}: serialized graph hash differs from the extracted artifact.`);
  }
  if (result.binaryBytes !== item.manifest.binary.bytes) {
    mismatches.push(`${label}: binary byte count differs from the extracted artifact.`);
  }
  if (result.version !== item.version || result.platform !== item.platform) {
    mismatches.push(`${label}: returned release target is incorrect.`);
  }

  const expected = expectedModules(item);
  if (result.modules.length !== expected.length) {
    mismatches.push(`${label}: module count differs from the extracted artifact.`);
  }
  for (let index = 0; index < Math.min(result.modules.length, expected.length); index++) {
    const actual = result.modules[index]!;
    const wanted = expected[index]!;
    for (const field of MODULE_FIELDS) {
      if (actual[field] !== wanted[field]) {
        mismatches.push(`${label}: module ${index}.${field} differs from the extracted artifact.`);
      }
    }
    if (actual.contentsSha256 !== wanted.contentsSha256) {
      mismatches.push(
        `${label}: module ${index} contents hash differs from the extracted artifact.`,
      );
    }
  }
}

function hashNormalizedKey(key: string) {
  return NodeCrypto.createHash("sha256").update(key, "utf8").digest("hex");
}

function proofSummary(
  binaryBytes: number,
  serializedGraphSha256: string,
  graph: Record<string, unknown>,
  modules: {
    index: number;
    name: string;
    key: string;
    encoding: number;
    loader: number;
    format: number;
    side: number;
    contentsSha256: string;
  }[],
): ProofSummary {
  return {
    binaryBytes,
    serializedGraphSha256,
    graph: Object.fromEntries(GRAPH_FIELDS.map((field) => [field, graph[field]])),
    modules: modules.map((module) => ({
      index: module.index,
      name: module.name,
      normalizedKeySha256: hashNormalizedKey(module.key),
      encoding: module.encoding,
      loader: module.loader,
      format: module.format,
      side: module.side,
      contentsSha256: module.contentsSha256,
    })),
  };
}

function resultSummary(observation: ProofObservation): MeasurementSummary {
  const result = observation.result;
  return {
    ...proofSummary(result.binaryBytes, result.serializedGraphSha256, result.graph, result.modules),
    inventory: observation.inventory ?? null,
  };
}

function manifestSummary(item: ProofCase): ProofSummary {
  const modules = expectedModules(item);
  return proofSummary(
    item.manifest.binary.bytes,
    item.manifest.serializedGraph.sha256,
    item.manifest.graph,
    modules,
  );
}

export function compareMeasurements(
  local: unknown,
  deployed: unknown,
  cases: ProofCase[],
): ComparisonEvidence {
  const mismatches: string[] = [];
  const validatedCases = cases.map((item) => ({
    ...item,
    manifest: validateManifest(item.manifest, `Manifest for ${item.version}/${item.platform}`),
  }));
  let inventoryReference: FixtureInventory | undefined;
  const comparedCases = validatedCases.map((item) => {
    const caseMismatches: string[] = [];
    const localObservation = proofResult(local, item, "local", caseMismatches);
    const deployedObservation = proofResult(deployed, item, "deployed", caseMismatches);
    for (const [environment, observation] of [
      ["local", localObservation],
      ["deployed", deployedObservation],
    ] as const) {
      if (!observation?.inventory) continue;
      if (!inventoryReference) inventoryReference = observation.inventory;
      else {
        compareFixtureInventories(
          inventoryReference,
          observation.inventory,
          `${environment} ${item.version}/${item.platform}`,
          caseMismatches,
        );
      }
    }
    if (localObservation)
      compareResult(
        item,
        localObservation.result,
        `local ${item.version}/${item.platform}`,
        caseMismatches,
      );
    if (deployedObservation)
      compareResult(
        item,
        deployedObservation.result,
        `deployed ${item.version}/${item.platform}`,
        caseMismatches,
      );
    mismatches.push(...caseMismatches);
    return {
      version: item.version,
      platform: item.platform,
      manifest: manifestSummary(item),
      ...(localObservation ? { local: resultSummary(localObservation) } : {}),
      ...(deployedObservation ? { deployed: resultSummary(deployedObservation) } : {}),
      mismatches: caseMismatches,
    };
  });
  return {
    schemaVersion: 1,
    status: mismatches.length === 0 ? "passed" : "failed",
    environments: { local: "local-workerd", deployed: "deployed" },
    cases: comparedCases,
    mismatches,
  };
}
