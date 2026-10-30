/** Default imports must reach the same overrides as named imports. */
export function overrideNativeModule(native: object, overrides: Readonly<Record<string, unknown>>) {
  const descriptors = Object.getOwnPropertyDescriptors(native);
  const hasDefault = Object.hasOwn(descriptors, "default");
  delete descriptors.default;
  for (const [member, value] of Object.entries(overrides)) {
    descriptors[member] = { value, enumerable: true, configurable: true, writable: true };
  }
  const result = Object.create(Object.getPrototypeOf(native), descriptors) as object;
  if (hasDefault) Object.defineProperty(result, "default", { value: result, enumerable: true });
  return result;
}
