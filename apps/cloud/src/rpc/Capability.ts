import { rpcStubOwner } from "./Resources.ts";

/** RPC arguments expire when their call returns; local targets need no duplication. */
export function retainRpcCapability<T extends object>(value: T) {
  const duplicate = Reflect.get(value, "dup");
  if (typeof duplicate !== "function") return { value, [Symbol.dispose]() {} };
  const held = Reflect.apply(duplicate, value, []) as T;
  return { value: held, [Symbol.dispose]: rpcStubOwner(held)[Symbol.dispose] };
}
