export function copyNativeExports(native: object): Record<string, unknown> {
  const module: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of Object.keys(native)) {
    if (name === "default") continue;
    const value: unknown = Reflect.get(native, name);
    if (typeof value === "function" && !/^[A-Z]/.test(name)) {
      module[name] = (...args: unknown[]) => Reflect.apply(value, native, args);
    } else {
      module[name] = value;
    }
  }
  return module;
}

export function defineDefault(module: Record<string, unknown>): object {
  Object.defineProperty(module, "default", {
    configurable: false,
    enumerable: true,
    value: module,
    writable: false,
  });
  return Object.freeze(module);
}
