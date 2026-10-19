import type { HarnessRelease } from "../Harness.ts";
import type {
  HarnessReleasePlanInput,
  PreparedReleaseModule,
  ReleaseComponent,
  ReleaseFile,
} from "./types.ts";

export class HarnessReleasePlanError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessReleasePlanError";
  }
}

export function rawManifest<A>(decode: (value: unknown) => A, value: unknown): A {
  try {
    return decode(value);
  } catch (cause) {
    throw new HarnessReleasePlanError("Invalid provider manifest", cause);
  }
}

export function relativeModuleName(name: string) {
  // Percent escapes are literal native module names in the published Claude chunks.
  if (
    /[\\:?#]/u.test(name) ||
    Array.from(name).some(
      (character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f,
    ) ||
    name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new HarnessReleasePlanError(`Expected a canonical relative module name: ${name}`);
}

export function componentManifest(input: HarnessReleasePlanInput, component: ReleaseComponent) {
  const path = input.manifest.components[component]?.manifest;
  if (path === undefined || !path.endsWith("/manifest.json"))
    throw new HarnessReleasePlanError(`Missing component manifest: ${component}`);
  if (!Object.hasOwn(input.manifest.files, path))
    throw new HarnessReleasePlanError(`Missing common component manifest payload: ${component}`);
  return path;
}

export function verifiedFile(
  input: HarnessReleasePlanInput,
  manifestPath: string,
  relativePath: string,
  descriptor: { readonly sha256: string; readonly bytes?: number },
) {
  const path = manifestPath.slice(0, -"manifest.json".length) + relativePath;
  const common = Object.hasOwn(input.manifest.files, path) ? input.manifest.files[path] : undefined;
  if (
    common === undefined ||
    common.sha256 !== descriptor.sha256 ||
    (descriptor.bytes !== undefined && common.bytes !== descriptor.bytes)
  )
    throw new HarnessReleasePlanError(`Provider descriptor disagrees with common payload: ${path}`);
  return { path, bytes: common.bytes, sha256: common.sha256 };
}

export function release(
  input: HarnessReleasePlanInput,
  version: string,
  modules: Readonly<Record<string, PreparedReleaseModule>>,
): HarnessRelease {
  return {
    harness: input.manifest.harness,
    version,
    manifestSha256: input.artifactHash,
    modules: Object.fromEntries(
      Object.entries(modules).map(([name, entry]) => [
        name,
        { bytes: entry.bytes, sha256: entry.sha256 },
      ]),
    ),
  };
}

export function declaredEntrypoint(
  component: ReleaseComponent,
  name: string,
  modules: Readonly<Record<string, { readonly type: string }>>,
) {
  const module = Object.hasOwn(modules, name) ? modules[name] : undefined;
  if (module === undefined || (module.type !== "js" && module.type !== "cjs"))
    throw new HarnessReleasePlanError(
      `Entrypoint must name a declared JS module: ${component}/${name}`,
    );
  return `${component}/${name}`;
}

export function sameDescriptor(left: ReleaseFile, right: ReleaseFile) {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}
