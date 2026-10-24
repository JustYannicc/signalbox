/** Give a returned RPC value the disposal hook Cloudflare attaches to transported objects. */
export function withRpcReplyDisposer<T extends object>(value: T, onDispose: () => void = () => {}) {
  let disposed = false;
  Object.defineProperty(value, Symbol.dispose, {
    value() {
      if (disposed) throw new Error("RPC reply disposed more than once");
      disposed = true;
      onDispose();
    },
  });
  return value;
}
