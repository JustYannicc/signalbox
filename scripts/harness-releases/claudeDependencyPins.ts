import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { parse as parseYaml } from "yaml";
import { isNodeErrorCode, record as asRecord, sha256, text as asText } from "./guards.ts";

const PINNED_DEPENDENCIES = [
  {
    importer: "scripts",
    section: "devDependencies",
    dependency: "esbuild",
    packageName: "esbuild",
    version: "0.28.2",
    specifier: "0.28.2",
  },
  {
    importer: "scripts",
    section: "devDependencies",
    dependency: "ajv",
    packageName: "ajv",
    version: "8.20.0",
    specifier: "8.20.0",
  },
  {
    importer: "scripts",
    section: "devDependencies",
    dependency: "typescript-legacy",
    packageName: "typescript",
    version: "6.0.3",
    specifier: "npm:typescript@~6.0.3",
  },
  {
    importer: "scripts",
    section: "devDependencies",
    dependency: "@cfworker/json-schema",
    packageName: "@cfworker/json-schema",
    version: "4.1.1",
    specifier: "4.1.1",
  },
  {
    importer: "apps/cloud",
    section: "devDependencies",
    dependency: "esbuild",
    packageName: "esbuild",
    version: "0.28.2",
    specifier: "0.28.2",
  },
  {
    importer: "apps/cloud",
    section: "devDependencies",
    dependency: "ws",
    packageName: "ws",
    version: "8.22.0",
    specifier: "catalog:",
  },
  {
    importer: "apps/cloud",
    section: "devDependencies",
    dependency: "node-fetch",
    packageName: "node-fetch",
    version: "2.7.0",
    specifier: "2.7.0",
  },
  {
    importer: "apps/cloud",
    section: "devDependencies",
    dependency: "punycode",
    packageName: "punycode",
    version: "2.3.1",
    specifier: "2.3.1",
  },
] as const;

export interface ClaudeDependencyPin {
  readonly importer: "scripts" | "apps/cloud";
  readonly dependency: string;
  readonly packageName: string;
  readonly version: string;
  readonly packageMetadataSha256: string;
  readonly packageLicense: string;
  readonly packageSpecifier: string;
  readonly lockVersion: string;
  readonly lockIntegrity: string;
}

const record = (value: unknown) => asRecord(value, "CLAUDE_INPUT_OBJECT_REQUIRED");
const text = (value: unknown, code: string) => asText(value, code);

function packageRoot(entry: string, expectedName: string) {
  let directory = NodePath.dirname(NodeFS.realpathSync(entry));
  for (;;) {
    const metadata = NodePath.join(directory, "package.json");
    try {
      const value = record(JSON.parse(NodeFS.readFileSync(metadata, "utf8")));
      if (value.name === expectedName) return { directory, metadata, value };
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`CLAUDE_DEPENDENCY_METADATA_MISSING: ${expectedName}`);
}

function packageVersion(value: unknown, expected: string, name: string) {
  const version = text(value, `CLAUDE_DEPENDENCY_VERSION_MISSING: ${name}`);
  if (version !== expected)
    throw new Error(
      `CLAUDE_DEPENDENCY_VERSION_MISMATCH: ${name}: expected ${expected}, got ${version}`,
    );
  return version;
}

function resolvedLockVersion(
  value: unknown,
  packageName: string,
  expected: string,
  dependency: string,
) {
  const version = text(value, `CLAUDE_DEPENDENCY_LOCK_MISSING: ${dependency}`);
  if (
    version !== expected &&
    version !== `${packageName}@${expected}` &&
    !version.startsWith(`${expected}(`) &&
    !version.startsWith(`${packageName}@${expected}(`)
  )
    throw new Error(`CLAUDE_DEPENDENCY_LOCK_MISMATCH: ${dependency}: ${version}`);
  return version;
}

export async function createClaudeDependencyPins(
  repository: string,
  lockBytes: Uint8Array,
): Promise<ClaudeDependencyPin[]> {
  const lock = record(parseYaml(lockBytes.toString()));
  const importers = record(lock.importers);
  const packages = record(lock.packages);
  const scriptsRequire = NodeModule.createRequire(
    NodePath.join(repository, "scripts/package.json"),
  );
  const cloudRequire = NodeModule.createRequire(
    NodePath.join(repository, "apps/cloud/package.json"),
  );
  const rootRequires = { scripts: scriptsRequire, "apps/cloud": cloudRequire } as const;
  const pins: ClaudeDependencyPin[] = [];

  for (const requirement of PINNED_DEPENDENCIES) {
    const importer = record(importers[requirement.importer]);
    const dependencyMap = record(importer[requirement.section]);
    const lockDependency = record(dependencyMap[requirement.dependency]);
    if (lockDependency.specifier !== requirement.specifier)
      throw new Error(`CLAUDE_DEPENDENCY_SPECIFIER_MISMATCH: ${requirement.dependency}`);
    const resolvedVersion = resolvedLockVersion(
      lockDependency.version,
      requirement.packageName,
      requirement.version,
      requirement.dependency,
    );
    const lockedPackage = record(packages[`${requirement.packageName}@${requirement.version}`]);
    const resolution = record(lockedPackage.resolution);
    const integrity = text(
      resolution.integrity,
      `CLAUDE_DEPENDENCY_INTEGRITY_MISSING: ${requirement.dependency}`,
    );
    const expectedPackageJson = record(
      JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(repository, requirement.importer, "package.json"),
          "utf8",
        ),
      ),
    );
    const declared = record(expectedPackageJson[requirement.section]);
    if (declared[requirement.dependency] !== requirement.specifier)
      throw new Error(`CLAUDE_DEPENDENCY_MANIFEST_MISMATCH: ${requirement.dependency}`);
    const resolutionSpecifier =
      requirement.dependency === "punycode" ? "punycode/" : requirement.dependency;
    const resolvedEntry = rootRequires[requirement.importer].resolve(resolutionSpecifier);
    const located = packageRoot(resolvedEntry, requirement.packageName);
    const version = packageVersion(
      located.value.version,
      requirement.version,
      requirement.dependency,
    );
    pins.push({
      importer: requirement.importer,
      dependency: requirement.dependency,
      packageName: requirement.packageName,
      version,
      packageMetadataSha256: sha256(await NodeFSP.readFile(located.metadata)),
      packageLicense: text(
        located.value.license,
        `CLAUDE_DEPENDENCY_LICENSE_MISSING: ${requirement.dependency}`,
      ),
      packageSpecifier: requirement.specifier,
      lockVersion: resolvedVersion,
      lockIntegrity: integrity,
    });
  }
  return pins;
}

export function assertClaudeDependencyPins(dependencies: ReadonlyArray<ClaudeDependencyPin>): void {
  const requirements = new Map(
    PINNED_DEPENDENCIES.map((item) => [`${item.importer}\0${item.dependency}`, item]),
  );
  if (dependencies.length !== PINNED_DEPENDENCIES.length)
    throw new Error("CLAUDE_DEPENDENCY_PIN_SET_MISMATCH");
  for (const dependency of dependencies) {
    const requirement = requirements.get(`${dependency.importer}\0${dependency.dependency}`);
    if (
      !requirement ||
      dependency.packageName !== requirement.packageName ||
      dependency.version !== requirement.version ||
      dependency.packageSpecifier !== requirement.specifier ||
      (dependency.lockVersion !== requirement.version &&
        dependency.lockVersion !== `${requirement.packageName}@${requirement.version}` &&
        !dependency.lockVersion.startsWith(`${requirement.version}(`) &&
        !dependency.lockVersion.startsWith(`${requirement.packageName}@${requirement.version}(`)) ||
      !dependency.packageMetadataSha256 ||
      !dependency.lockIntegrity ||
      !/^[a-f0-9]{64}$/u.test(dependency.packageMetadataSha256)
    )
      throw new Error(`CLAUDE_DEPENDENCY_PROVENANCE_INCOMPLETE: ${dependency.dependency}`);
  }
}
