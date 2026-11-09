export function signalboxStateStore(): never {
  throw new Error(
    "this stack needs a Signalbox-owned state store; the shared alchemy-state-store is forbidden",
  );
}
