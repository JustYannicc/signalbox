import * as NodeModule from "node:module";
import ts from "typescript-legacy";
import { unwrapRequireExpression } from "../../claude-bunfs/release-inventory-require.ts";

interface BuiltinModuleReference {
  readonly kind: "module";
  readonly specifier: string;
}

interface BuiltinMemberReference {
  readonly kind: "member";
  readonly specifier: string;
  readonly memberPath: readonly string[];
}

interface DynamicBuiltinMemberReference {
  readonly kind: "dynamic-member";
  readonly specifier: string;
  readonly memberPath: readonly string[];
}

interface BuiltinRequireReference {
  readonly kind: "require";
}

interface BuiltinRequireFactoryReference {
  readonly kind: "require-factory";
}

interface BuiltinModuleLoaderReference {
  readonly kind: "module-loader";
}

interface UncertainLoaderReference {
  readonly kind: "dynamic-require" | "dynamic-module-loader" | "dynamic-node-bridge";
}

interface DynamicImportPromiseReference {
  readonly kind: "dynamic-import-promise" | "unknown-import-promise";
  readonly specifier: string;
}

interface ExternalValueReference {
  readonly kind: "external-value";
  readonly specifier: string;
  readonly memberPath: readonly string[];
}

interface NodeBridgeReference {
  readonly kind: "node-bridge";
}

interface CommonJsFacadeReference {
  readonly kind: "commonjs-facade" | "unknown-commonjs-facade";
  readonly specifier: string;
}

interface BundledModuleReference {
  readonly kind: "bundled-module" | "dynamic-module";
  readonly specifier: string;
}

export type BuiltinReference =
  | BuiltinModuleReference
  | BuiltinMemberReference
  | DynamicBuiltinMemberReference
  | BuiltinRequireReference
  | BuiltinRequireFactoryReference
  | BuiltinModuleLoaderReference
  | UncertainLoaderReference
  | DynamicImportPromiseReference
  | ExternalValueReference
  | NodeBridgeReference
  | CommonJsFacadeReference
  | BundledModuleReference;

export type BuiltinFunctionAnalysisOrigin =
  | BuiltinReference
  | "module"
  | "process"
  | "factory"
  | "builtin-loader"
  | "require"
  | "bridge";

export function isBuiltinReference(
  value: BuiltinFunctionAnalysisOrigin | undefined,
): value is BuiltinReference {
  return typeof value === "object" && value !== null;
}

export const literal = (node: ts.Node | undefined) =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined;

export function builtinSpecifier(value: string | undefined): string | undefined {
  if (!value || !NodeModule.isBuiltin(value)) return undefined;
  return value.replace(/^node:/u, "");
}

export function staticMember(node: ts.Expression) {
  node = unwrapRequireExpression(node);
  if (ts.isPropertyAccessExpression(node)) return { target: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node))
    return { target: node.expression, name: literal(node.argumentExpression) };
  return undefined;
}

export const moduleReference = (specifier: string): BuiltinModuleReference => ({
  kind: "module",
  specifier,
});

const nonCallableProcessMembers = new Set([
  "arch",
  "argv",
  "argv0",
  "config",
  "env",
  "execArgv",
  "execPath",
  "exitCode",
  "features",
  "main",
  "mainModule",
  "pid",
  "platform",
  "ppid",
  "release",
  "state",
  "version",
  "versions",
]);

export function builtinMemberReference(
  reference: BuiltinReference | undefined,
  name: string | undefined,
): BuiltinReference | undefined {
  if (!reference) return undefined;
  if (reference.kind === "node-bridge") return name === "require" ? { kind: "require" } : undefined;
  if (reference.kind === "dynamic-node-bridge" || reference.kind === "dynamic-module-loader")
    return name === "require" ? { kind: "dynamic-require" } : undefined;
  if (
    (reference.kind === "require" ||
      reference.kind === "require-factory" ||
      reference.kind === "dynamic-require") &&
    (name === undefined || name === "call" || name === "apply" || name === "bind")
  )
    // Loader indirection needs argument and receiver analysis; keep its invocation blocking.
    return { kind: "dynamic-require" };
  if (reference.kind === "commonjs-facade" || reference.kind === "unknown-commonjs-facade")
    return undefined;
  if (
    name !== undefined &&
    (reference.kind === "module" ||
      reference.kind === "bundled-module" ||
      reference.kind === "member")
  ) {
    const memberPath = reference.kind === "member" ? [...reference.memberPath, name] : [name];
    const processData =
      reference.specifier === "process" &&
      memberPath.length === 1 &&
      nonCallableProcessMembers.has(name);
    const pathData =
      ["path", "path/posix", "path/win32"].includes(reference.specifier) &&
      (name === "sep" || name === "delimiter") &&
      (memberPath.length === 1 ||
        (memberPath.length === 2 && (memberPath[0] === "posix" || memberPath[0] === "win32")));
    const tlsData =
      reference.specifier === "tls" && memberPath.length === 1 && name === "rootCertificates";
    if (processData || pathData || tlsData)
      return { kind: "external-value", specifier: reference.specifier, memberPath };
  }
  if (reference.kind === "bundled-module")
    return name === "default"
      ? reference
      : name === undefined
        ? { kind: "dynamic-member", specifier: reference.specifier, memberPath: [] }
        : { kind: "member", specifier: reference.specifier, memberPath: [name] };
  if (reference.kind === "dynamic-module")
    return name === "default"
      ? reference
      : name === undefined
        ? { kind: "dynamic-member", specifier: reference.specifier, memberPath: [] }
        : { kind: "dynamic-member", specifier: reference.specifier, memberPath: [name] };
  if (reference.kind === "module") {
    if (name === "default") return reference;
    return name === undefined
      ? { kind: "dynamic-member", specifier: reference.specifier, memberPath: [] }
      : { kind: "member", specifier: reference.specifier, memberPath: [name] };
  }
  if (reference.kind === "member") {
    if (name === "default") return reference;
    return name === undefined
      ? {
          kind: "dynamic-member",
          specifier: reference.specifier,
          memberPath: reference.memberPath,
        }
      : {
          kind: "member",
          specifier: reference.specifier,
          memberPath: [...reference.memberPath, name],
        };
  }
  if (reference.kind === "dynamic-member")
    return {
      ...reference,
      memberPath: name === undefined ? reference.memberPath : [...reference.memberPath, name],
    };
  if (reference.kind === "external-value")
    return {
      ...reference,
      memberPath: name === undefined ? reference.memberPath : [...reference.memberPath, name],
    };
  if (reference.kind === "module-loader" && name === "require") return { kind: "require" };
  return undefined;
}

export function uncertainBuiltinReference(reference: BuiltinReference): BuiltinReference {
  if (reference.kind === "commonjs-facade")
    return { kind: "unknown-commonjs-facade", specifier: reference.specifier };
  if (reference.kind === "module" || reference.kind === "bundled-module")
    return { kind: "dynamic-module", specifier: reference.specifier };
  if (reference.kind === "member") return { ...reference, kind: "dynamic-member" };
  if (reference.kind === "require" || reference.kind === "require-factory")
    return { kind: "dynamic-require" };
  if (reference.kind === "module-loader") return { kind: "dynamic-module-loader" };
  if (reference.kind === "node-bridge") return { kind: "dynamic-node-bridge" };
  if (reference.kind === "dynamic-import-promise")
    return { ...reference, kind: "unknown-import-promise" };
  return reference;
}

export function isUncertainBuiltinReference(reference: BuiltinReference): boolean {
  return (
    reference.kind === "dynamic-module" ||
    reference.kind === "dynamic-member" ||
    reference.kind === "unknown-commonjs-facade" ||
    reference.kind === "dynamic-require" ||
    reference.kind === "dynamic-module-loader" ||
    reference.kind === "dynamic-node-bridge" ||
    reference.kind === "unknown-import-promise"
  );
}

export function sameReference(
  left: BuiltinReference | undefined,
  right: BuiltinReference,
): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (
    (left.kind === "commonjs-facade" ||
      left.kind === "unknown-commonjs-facade" ||
      left.kind === "bundled-module" ||
      left.kind === "dynamic-module") &&
    (right.kind === "commonjs-facade" ||
      right.kind === "unknown-commonjs-facade" ||
      right.kind === "bundled-module" ||
      right.kind === "dynamic-module")
  )
    return left.specifier === right.specifier;
  if (left.kind === "module" && right.kind === "module") return left.specifier === right.specifier;
  if (left.kind === "member" && right.kind === "member")
    return (
      left.specifier === right.specifier &&
      left.memberPath.join("\0") === right.memberPath.join("\0")
    );
  if (left.kind === "dynamic-member" && right.kind === "dynamic-member")
    return (
      left.specifier === right.specifier &&
      left.memberPath.join("\0") === right.memberPath.join("\0")
    );
  if (
    (left.kind === "dynamic-import-promise" || left.kind === "unknown-import-promise") &&
    (right.kind === "dynamic-import-promise" || right.kind === "unknown-import-promise")
  )
    return left.specifier === right.specifier;
  return true;
}
