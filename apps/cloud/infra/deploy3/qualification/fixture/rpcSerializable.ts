// JSON-backed RPC data cannot contain local module factories or deferred values.
export type RpcSerializable<T> =
  T extends PromiseLike<unknown>
    ? never
    : T extends (...args: never[]) => unknown
      ? never
      : T extends ArrayBuffer | ArrayBufferView
        ? T
        : T extends readonly (infer Item)[]
          ? readonly RpcSerializable<Item>[]
          : T extends object
            ? { readonly [Key in keyof T]: RpcSerializable<T[Key]> }
            : T;
