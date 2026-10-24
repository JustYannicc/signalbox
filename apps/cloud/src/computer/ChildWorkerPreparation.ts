import type { ChildWorkerSlotRequest } from "./ChildWorkerCapacity.ts";
import type { ChildWorkerCode, ChildWorkerModules } from "./ChildWorkerCode.ts";
import { childWorkerDispatchCodeId } from "./ChildWorkerDispatchCode.ts";

/** Admission and execution must use the same captured modules, including factory output. */
export function createChildWorkerPreparation(code: ChildWorkerCode) {
  const source = code.modules;
  const captured = typeof source === "function" ? undefined : captureModules(source);
  const modulesByRequest = new WeakMap<ChildWorkerSlotRequest, ChildWorkerModules>();
  return {
    async prepare(residentBytes = 0): Promise<ChildWorkerSlotRequest> {
      if (!Number.isSafeInteger(residentBytes) || residentBytes < 0) {
        throw new RangeError("Invalid initial child residency");
      }
      const modules =
        captured ??
        captureModules(await (source as () => Promise<ChildWorkerModules> | ChildWorkerModules)());
      const codeId = await childWorkerDispatchCodeId({
        ...code,
        modules,
        command: { executable: "", argv: [], cwd: "/", env: {} },
      });
      const request = Object.freeze({ codeId, residentBytes });
      modulesByRequest.set(request, modules);
      return request;
    },
    claim(request: ChildWorkerSlotRequest): ChildWorkerModules {
      const modules = modulesByRequest.get(request);
      if (modules === undefined) {
        throw new TypeError("Child reservation does not belong to this prepared program");
      }
      modulesByRequest.delete(request);
      return modules;
    },
  };
}

function captureModules(modules: ChildWorkerModules): ChildWorkerModules {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(modules).map(([name, module]) => [
        name,
        typeof module === "string"
          ? module
          : "wasmReference" in module
            ? Object.freeze({ wasmReference: module.wasmReference })
            : "wasm" in module
              ? Object.freeze({ wasm: module.wasm })
              : Object.freeze({ js: module.js }),
      ]),
    ),
  );
}
