import { describe, expect, it } from "vite-plus/test";
import {
  createHarnessProcessFacetEnvironment,
  type HarnessProcessExecutionProcessInput,
} from "../HarnessProcessPlacement.ts";

const process: HarnessProcessExecutionProcessInput = {
  processId: "actual-process",
  codeId: "actual-code",
  residentBytes: 1,
  nativeSessionId: "native-session",
  checkpointId: "checkpoint",
  manifestRevision: "manifest",
  operationId: "operation",
  priorFacetNonce: "prior-facet",
  expectedFacetGeneration: 1,
  mainModule: "main.mjs",
  modules: { "main.mjs": "export default {}" },
  entrypoint: "Facet",
  facetEnv: {
    HARNESS_C_PRODUCT_BOOTSTRAP: "caller-descriptor",
    HARNESS_C_TARGET_PREPARED_RELEASE: "caller-target",
    HARNESS_C_PRODUCT_CAPABILITIES: "caller-capabilities",
    HARNESS_PROCESS_ID: "caller-process",
    HARNESS_PROCESS_SHARD_OWNER: "caller-owner",
    HARNESS_PROCESS_LOADER_ID: "caller-loader",
    HARNESS_PROCESS_FACET_KEY: "caller-facet",
    HARNESS_REQUEST_PUBLISHER: { generation: 99, publisherKey: "caller-publisher" },
    HARNESS_RESUME_RUN_ID: "caller-run",
    HARNESS_RESUME_CONTROL: "caller-control",
    HARNESS_RESUME_PUBLISHER: "caller-a-publisher",
    HARNESS_RESUME_RUN_STORE: "caller-run-store",
    HARNESS_RESUME_FILES_STORE: "caller-files-store",
    HARNESS_RESUME_SUPERVISOR: "caller-supervisor",
  },
};

describe("process facet environment transport", () => {
  it("drops caller C, process and resume fields when typed inputs and bindings are absent", () => {
    const environment = createHarnessProcessFacetEnvironment(
      process,
      {},
      { shardOwner: "actual-owner", loaderId: "actual-loader", facetKey: "actual-facet" },
    );

    expect(environment).not.toHaveProperty("HARNESS_C_PRODUCT_BOOTSTRAP");
    expect(environment).not.toHaveProperty("HARNESS_C_TARGET_PREPARED_RELEASE");
    expect(environment).not.toHaveProperty("HARNESS_C_PRODUCT_CAPABILITIES");
    expect(environment).not.toHaveProperty("HARNESS_REQUEST_PUBLISHER");
    expect(environment).toMatchObject({
      HARNESS_PROCESS_ID: "actual-process",
      HARNESS_PROCESS_SHARD_OWNER: "actual-owner",
      HARNESS_PROCESS_LOADER_ID: "actual-loader",
      HARNESS_PROCESS_FACET_KEY: "actual-facet",
    });
    for (const key of [
      "HARNESS_RESUME_RUN_ID",
      "HARNESS_RESUME_CONTROL",
      "HARNESS_RESUME_PUBLISHER",
      "HARNESS_RESUME_RUN_STORE",
      "HARNESS_RESUME_FILES_STORE",
      "HARNESS_RESUME_SUPERVISOR",
    ])
      expect(environment).not.toHaveProperty(key);
  });
});
