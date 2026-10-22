import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";

/** Keeps the native inspector surface while owning the no-active-inspector url behavior. */
export function createNodeInspectorModule(nativeInspector: object): object {
  const nativeUrl: unknown = Reflect.get(nativeInspector, "url");
  const url = markNodeBuiltinCapability(
    () =>
      typeof nativeUrl === "function" ? Reflect.apply(nativeUrl, nativeInspector, []) : undefined,
    {
      status: "supported",
      evidence:
        "inspector.url delegates to the personality inspector and returns undefined when no inspector is active",
    },
  );

  const descriptors = Object.getOwnPropertyDescriptors(nativeInspector);
  delete descriptors.url;
  const module = Object.create(Object.getPrototypeOf(nativeInspector)) as object;
  Object.defineProperties(module, descriptors);
  Object.defineProperty(module, "url", {
    value: url,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return module;
}
