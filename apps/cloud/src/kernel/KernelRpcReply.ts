/** Local ports return plain values; RPC ports attach ownership to the received reply. */
export function disposeKernelRpcReply(reply: unknown): void {
  replyDisposer(reply)?.();
}

/** Plain data records can be retained after releasing RPC ownership, without copying byte regions. */
export function copyKernelRpcRecord<Value extends object>(reply: Value): Value {
  const dispose = replyDisposer(reply);
  if (dispose === undefined) return reply;
  try {
    const value = { ...reply };
    Reflect.deleteProperty(value, Symbol.dispose);
    return value;
  } finally {
    dispose();
  }
}

function replyDisposer(reply: unknown): (() => void) | undefined {
  if ((typeof reply !== "object" && typeof reply !== "function") || reply === null) return;
  const dispose = Reflect.get(reply, Symbol.dispose);
  if (typeof dispose === "function") return () => dispose.call(reply);
}
