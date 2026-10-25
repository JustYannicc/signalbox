// @effect-diagnostics nodeBuiltinImport:off globalDate:off - this CLI owns filesystem reads and evidence writes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { compareMeasurements, type ProofCase, type ProofManifest } from "./prove-comparison.ts";

const PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "win32-x64",
  "win32-arm64",
]);

type CaseInput = { version: string; platform: string; manifestPath: string };

function usage(): never {
  throw new Error(
    "Usage: node scripts/claude-bunfs/prove.ts compare --local <measure.json> --deployed <measure.json> --evidence <outside-checkout.json> --case <version> <platform> <manifest.json> [--case ...]",
  );
}

function parseArgs(argv: string[]) {
  if (argv.shift() !== "compare") usage();
  let localPath: string | undefined;
  let deployedPath: string | undefined;
  let evidencePath: string | undefined;
  const cases: CaseInput[] = [];

  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--local") localPath = argv.shift();
    else if (flag === "--deployed") deployedPath = argv.shift();
    else if (flag === "--evidence") evidencePath = argv.shift();
    else if (flag === "--case") {
      const version = argv.shift();
      const platform = argv.shift();
      const manifestPath = argv.shift();
      if (!version || !platform || !manifestPath) usage();
      cases.push({ version, platform, manifestPath });
    } else usage();
  }

  if (!localPath || !deployedPath || !evidencePath || cases.length === 0) usage();
  const seen = new Set<string>();
  for (const item of cases) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.version)) {
      throw new Error(`Invalid strict semver version: ${item.version}`);
    }
    if (!PLATFORMS.has(item.platform)) {
      throw new Error(`Unsupported Claude Code platform: ${item.platform}`);
    }
    const key = `${item.version}/${item.platform}`;
    if (seen.has(key)) throw new Error(`Duplicate proof case: ${key}`);
    seen.add(key);
  }

  const resolvedEvidencePath = NodePath.resolve(evidencePath);
  const repoRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../..",
  );
  const relativeToRepo = NodePath.relative(repoRoot, resolvedEvidencePath);
  if (
    relativeToRepo !== ".." &&
    !relativeToRepo.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relativeToRepo)
  ) {
    throw new Error("--evidence must point outside this checkout.");
  }
  return { localPath, deployedPath, evidencePath: resolvedEvidencePath, cases };
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is not readable JSON.`);
  }
}

async function readCase(input: CaseInput): Promise<ProofCase> {
  const label = `Manifest for ${input.version}/${input.platform}`;
  const manifest = await readJson(input.manifestPath, label);
  return {
    version: input.version,
    platform: input.platform,
    manifest: manifest as ProofManifest,
  };
}

async function saveEvidence(path: string, evidence: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
}

export async function runProof(argv: string[]) {
  const options = parseArgs(argv);
  const [localInput, deployedInput, cases] = await Promise.all([
    readJson(options.localPath, "Local measurement"),
    readJson(options.deployedPath, "Deployed measurement"),
    Promise.all(options.cases.map(readCase)),
  ]);
  const comparison = compareMeasurements(localInput, deployedInput, cases);
  const evidence = { ...comparison, createdAt: new Date().toISOString() };
  await saveEvidence(options.evidencePath, evidence);
  if (evidence.mismatches.length > 0) {
    for (const mismatch of evidence.mismatches) process.stderr.write(`FAIL ${mismatch}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `PASS ${cases.length} proof cases matched both measurements and extracted manifests.\n`,
  );
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await runProof(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown comparison error";
    process.stderr.write(`FAIL ${message}\n`);
    process.exitCode = 1;
  });
}
