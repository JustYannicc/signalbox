export type NodeBuiltinFailure = Readonly<{
  kind: "named-error";
  code: string;
}>;

export type NodeBuiltinCapabilityDeclaration = Readonly<{
  status: "supported" | "unsupported" | "conditional" | "platform-pruned";
  evidence: string;
  failure?: NodeBuiltinFailure;
}>;

type Callable = (...args: never[]) => unknown;

const declarations = new WeakMap<object, NodeBuiltinCapabilityDeclaration>();

export function markNodeBuiltinCapability<T extends Callable>(
  callable: T,
  declaration: NodeBuiltinCapabilityDeclaration,
): T {
  if (typeof callable !== "function") {
    throw new TypeError("Node builtin capability metadata requires a function");
  }
  if (typeof declaration.evidence !== "string" || declaration.evidence.trim() === "") {
    throw new TypeError("Node builtin capability evidence must be non-empty");
  }
  const failure = declaration.failure;
  if (
    failure !== undefined &&
    (declaration.status !== "unsupported" ||
      failure.kind !== "named-error" ||
      typeof failure.code !== "string" ||
      failure.code.trim() === "")
  ) {
    throw new TypeError(
      "Named-error metadata requires an unsupported callable and a non-empty code",
    );
  }

  const existing = declarations.get(callable);
  if (existing) {
    if (
      existing.status !== declaration.status ||
      existing.evidence !== declaration.evidence ||
      existing.failure?.kind !== failure?.kind ||
      existing.failure?.code !== failure?.code
    ) {
      throw new Error("Node builtin function already has different capability metadata");
    }
    return callable;
  }

  declarations.set(
    callable,
    Object.freeze({
      status: declaration.status,
      evidence: declaration.evidence,
      ...(failure === undefined ? {} : { failure: Object.freeze({ ...failure }) }),
    }),
  );
  return callable;
}

export function getNodeBuiltinCapability(
  callable: object,
): NodeBuiltinCapabilityDeclaration | undefined {
  return declarations.get(callable);
}
