/** Snapshot catalog identities without changing exact custom-policy matching. */
export function createComputerIsolatePolicy(executables: Iterable<string>) {
  return Object.freeze({
    isolateExecutables: Object.freeze([...executables]),
    default: "machine" as const,
  });
}
