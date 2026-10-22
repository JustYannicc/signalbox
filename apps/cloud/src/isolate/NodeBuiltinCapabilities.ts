export type NodeBuiltinCapabilityDeclaration = Readonly<{
  status: "supported" | "unsupported" | "conditional" | "platform-pruned";
  evidence: string;
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

  const existing = declarations.get(callable);
  if (existing) {
    if (existing.status !== declaration.status || existing.evidence !== declaration.evidence) {
      throw new Error("Node builtin function already has different capability metadata");
    }
    return callable;
  }

  declarations.set(
    callable,
    Object.freeze({ status: declaration.status, evidence: declaration.evidence }),
  );
  return callable;
}

export function getNodeBuiltinCapability(
  callable: object,
): NodeBuiltinCapabilityDeclaration | undefined {
  return declarations.get(callable);
}
