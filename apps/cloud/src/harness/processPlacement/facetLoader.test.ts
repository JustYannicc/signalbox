import { expect, it } from "vite-plus/test";
import { createHarnessProcessFacet } from "../HarnessProcessFacet.ts";
import type {
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionProcessInput,
} from "../HarnessProcessPlacement.ts";

function fixture(failConstruction = false) {
  const disposed: string[] = [];
  const loadedCode: Array<Promise<WorkerLoaderWorkerCode>> = [];
  const owned = (name: string) => ({
    [Symbol.dispose]() {
      disposed.push(name);
    },
  });
  const facet = {
    ...owned("facet"),
    identity: async () => ({ facetNonce: "nonce" }),
    dispose: async () => {},
  };
  const workerClass = owned("class");
  const worker = { ...owned("worker"), getDurableObjectClass: () => workerClass };
  const ctx = {
    facets: {
      get() {
        if (failConstruction) throw new Error("facet construction failed");
        return facet;
      },
    },
  } as unknown as DurableObjectState;
  const env = {
    LOADER: {
      get(_id: string, load: () => Promise<WorkerLoaderWorkerCode>) {
        loadedCode.push(load());
        return worker;
      },
    },
  } as unknown as HarnessProcessExecutionEnvironment;
  const process = {
    processId: "p",
    codeId: "code",
    residentBytes: 1,
    mainModule: "main.mjs",
    entrypoint: "Facet",
    modules: { "main.mjs": { js: "export class Facet {}" } },
  } as unknown as HarnessProcessExecutionProcessInput;
  return {
    disposed,
    loadedCode,
    open: () =>
      createHarnessProcessFacet(ctx, env, process, {
        facetKey: "loader",
        loaderId: "loader",
        shardOwner: "owner",
      }),
  };
}

it("keeps the facet's Worker Loader resources until its domain lifetime closes", async () => {
  const f = fixture();
  const facet = f.open();
  expect(await facet.identity()).toEqual({ facetKey: "loader", incarnationNonce: "nonce" });
  expect(f.disposed).toEqual([]);
  await facet.dispose();
  await facet.dispose();
  expect(f.disposed).toEqual(["facet", "class", "worker"]);
});

it("releases constructed Loader resources when facet lookup throws", () => {
  const f = fixture(true);
  expect(f.open).toThrow("facet construction failed");
  expect(f.disposed).toEqual(["class", "worker"]);
});

it("loads the facet module source with the new module registry", async () => {
  const f = fixture();
  const facet = f.open();
  expect(f.loadedCode).toHaveLength(1);
  const code = await f.loadedCode[0];
  expect(code).toMatchObject({
    compatibilityFlags: ["nodejs_compat", "new_module_registry"],
    mainModule: "main.mjs",
    modules: { "main.mjs": { js: "export class Facet {}" } },
  });
  await facet.dispose();
});
