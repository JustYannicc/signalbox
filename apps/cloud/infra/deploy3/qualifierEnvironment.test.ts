import { expect, it } from "vite-plus/test";
import { deploy3BootstrapIdentity } from "./expiry.ts";
import { validateDeploy3Plan } from "./deploymentPlan.ts";
import {
  deploy3QualifierEnvironment,
  materializeDeploy3QualifierEnvironment,
} from "./qualifierEnvironment.ts";
import {
  assertQualifierRuntimeConfiguration,
  decodeQualifierPlannedConfiguration,
} from "./qualification/environmentContract.ts";

const runId = "12345678";
const startedAtUtc = "2026-10-31T00:00:00.000Z";
const plan = {
  runId,
  owners: ["1070"] as const,
  startedAtUtc,
  main: "/build/qualifier-worker.mjs",
  assetsDirectory: "/build/assets",
  compatibilityDate: "2026-10-19",
  compatibilityFlags: ["nodejs_compat"],
  vars: {
    RUN_ID: "12345678-1234-4234-8234-123456789abc",
    WORKER_NAME: deploy3BootstrapIdentity(runId, Date.parse(startedAtUtc)).workerName,
    CONFIG_SHA256: "a".repeat(64),
    BUNDLE_SHA256: "b".repeat(64),
  },
};

it("rejects the pre-fix materialized environment and supplies the normal Alchemy default", () => {
  const current = validateDeploy3Plan(plan, runId).environment;
  const { RESIDENT_BYTE_LIMIT: omitted, ...preFix } = current;
  expect(omitted).toBe(String(104 * 1024 * 1024));
  expect(() => decodeQualifierPlannedConfiguration(preFix)).toThrow("RESIDENT_BYTE_LIMIT");
  expect(
    validateDeploy3Plan(
      { ...plan, vars: { ...plan.vars, RESIDENT_BYTE_LIMIT: "200000000" } },
      runId,
    ).environment.RESIDENT_BYTE_LIMIT,
  ).toBe("200000000");
});

it.each(["RUN_ID", "WORKER_NAME", "CONFIG_SHA256", "BUNDLE_SHA256"])(
  "rejects a missing or mistyped %s at plan time",
  (key) => {
    const vars: Record<string, string> = { ...plan.vars };
    delete vars[key];
    expect(() => validateDeploy3Plan({ ...plan, vars }, runId)).toThrow();
    expect(() =>
      validateDeploy3Plan({ ...plan, vars: { ...plan.vars, [key]: "invalid" } }, runId),
    ).toThrow();
  },
);

it.each(["", "0", "-1", "1.5", "Infinity", "9007199254740992"])(
  "rejects the invalid explicit residency override %j",
  (value) => {
    expect(() =>
      validateDeploy3Plan({ ...plan, vars: { ...plan.vars, RESIDENT_BYTE_LIMIT: value } }, runId),
    ).toThrow("RESIDENT_BYTE_LIMIT");
  },
);

const bindingNames = [
  "QUALIFIER",
  "CLAUDE_FIXTURES",
  "HARNESS_RUN_STORE",
  "HARNESS_FILES_STORE",
  "HARNESS_THREAD_SUPERVISOR",
  "PLACEMENT_STORES",
  "PROCESS_EXECUTION_SHARDS",
  "LOADER",
  "PROGRAM_ASSETS",
  "QUALIFIER_COMMANDS",
  "QUALIFIER_TAIL",
] as const;

function runtimeEnvironment() {
  const namespace = { get() {}, getByName() {}, idFromName() {} };
  const materialized = materializeDeploy3QualifierEnvironment(
    deploy3QualifierEnvironment(plan.vars),
    {
      namespace: () => namespace,
      loader: () => ({ get() {}, load() {} }),
    },
  );
  return {
    ...materialized.env,
    QUALIFIER: namespace,
    CLAUDE_FIXTURES: namespace,
    HARNESS_RUN_STORE: namespace,
    HARNESS_FILES_STORE: namespace,
    HARNESS_THREAD_SUPERVISOR: namespace,
    PLACEMENT_STORES: namespace,
    PROCESS_EXECUTION_SHARDS: namespace,
    PROGRAM_ASSETS: { fetch() {} },
    QUALIFIER_COMMANDS: { fetch() {}, run() {} },
    QUALIFIER_TAIL: { fetch() {}, tail() {}, captureOuter() {} },
  };
}

it.each(bindingNames)("requires the actual %s descriptor and runtime protocol", (name) => {
  const planned = deploy3QualifierEnvironment(plan.vars);
  const runtime = runtimeEnvironment();
  expect(() => decodeQualifierPlannedConfiguration(planned)).not.toThrow();
  expect(() => assertQualifierRuntimeConfiguration(runtime)).not.toThrow();
  expect(() => decodeQualifierPlannedConfiguration({ ...planned, [name]: undefined })).toThrow(
    name,
  );
  expect(() => decodeQualifierPlannedConfiguration({ ...planned, [name]: {} })).toThrow(name);
  expect(() => assertQualifierRuntimeConfiguration({ ...runtime, [name]: undefined })).toThrow(
    name,
  );
  expect(() => assertQualifierRuntimeConfiguration({ ...runtime, [name]: planned[name] })).toThrow(
    name,
  );
});

it("checks all live methods used by the loader and namespace consumers", () => {
  const env = runtimeEnvironment();
  expect(() => assertQualifierRuntimeConfiguration({ ...env, LOADER: { get() {} } })).toThrow(
    "LOADER",
  );
  for (const method of ["get", "getByName", "idFromName"]) {
    expect(() =>
      assertQualifierRuntimeConfiguration({
        ...env,
        HARNESS_RUN_STORE: { ...env.HARNESS_RUN_STORE, [method]: undefined },
      }),
    ).toThrow("HARNESS_RUN_STORE");
  }
});
