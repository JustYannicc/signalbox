import type { NodeFsModules } from "./NodeFs.ts";

/** Uses workerd's constants while keeping filesystem flags in step with KernelFileSystem. */
export function createNodeConstants(
  nativeConstants: object,
  fs: Pick<NodeFsModules["fs"], "constants">,
) {
  if (!nativeConstants || typeof nativeConstants !== "object") {
    throw new TypeError("Node constants requires the native constants module");
  }
  if (!fs || !fs.constants || typeof fs.constants !== "object") {
    throw new TypeError("Node constants requires the bridged fs.constants");
  }

  // graceful-fs calls constants.hasOwnProperty before it initializes file locking.
  const constants = Object.assign({} as Record<string, unknown>, nativeConstants, fs.constants);
  Object.defineProperty(constants, "default", {
    configurable: false,
    enumerable: true,
    value: constants,
    writable: false,
  });
  return Object.freeze(constants);
}

export default createNodeConstants;
