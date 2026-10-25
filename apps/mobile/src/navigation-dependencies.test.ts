import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

/**
 * React Navigation packages call each other's hooks by shape, so a workspace
 * override that resolves one below another's declared range fails only at
 * runtime (`render is not a function` in createNativeStackNavigator). This
 * walks the installed graph from the app and checks every caret range holds.
 */

const NAVIGATION_SCOPE = "@react-navigation/";

interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

interface PackageManifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

function readInstalled(name: string, fromManifestPath: string): InstalledPackage {
  const require = NodeModule.createRequire(fromManifestPath);
  const manifestPath = require.resolve(`${name}/package.json`);
  const manifest = require(manifestPath) as PackageManifest;
  return {
    name,
    version: manifest.version,
    manifestPath,
    dependencies: { ...manifest.dependencies, ...manifest.peerDependencies },
  };
}

function parseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split("-")[0]!.split(".").map(Number);
  return [major, minor, patch];
}

function satisfiesCaret(version: string, range: string): boolean {
  const floor = parseVersion(range.slice(1));
  const actual = parseVersion(version);
  if (actual[0] !== floor[0]) return false;
  for (let index = 1; index < 3; index++) {
    if (actual[index]! !== floor[index]!) return actual[index]! > floor[index]!;
  }
  return true;
}

function collectNavigationGraph(): InstalledPackage[] {
  const appRequire = NodeModule.createRequire(import.meta.url);
  const appManifestPath = appRequire.resolve("../package.json");
  const appManifest = appRequire(appManifestPath) as PackageManifest;
  const queue = Object.keys(appManifest.dependencies ?? {})
    .filter((name) => name.startsWith(NAVIGATION_SCOPE))
    .map((name) => readInstalled(name, appManifestPath));
  const seen = new Map<string, InstalledPackage>();
  while (queue.length > 0) {
    const pkg = queue.shift()!;
    if (seen.has(pkg.manifestPath)) continue;
    seen.set(pkg.manifestPath, pkg);
    for (const dependency of Object.keys(pkg.dependencies)) {
      if (dependency.startsWith(NAVIGATION_SCOPE)) {
        queue.push(readInstalled(dependency, pkg.manifestPath));
      }
    }
  }
  return [...seen.values()];
}

describe("React Navigation install", () => {
  it("resolves every @react-navigation dependency inside its declared range", () => {
    const violations: string[] = [];
    for (const pkg of collectNavigationGraph()) {
      for (const [dependency, range] of Object.entries(pkg.dependencies)) {
        if (!dependency.startsWith(NAVIGATION_SCOPE) || !range.startsWith("^")) continue;
        const installed = readInstalled(dependency, pkg.manifestPath);
        if (!satisfiesCaret(installed.version, range)) {
          violations.push(
            `${pkg.name}@${pkg.version} wants ${dependency}@${range}, got ${installed.version}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
