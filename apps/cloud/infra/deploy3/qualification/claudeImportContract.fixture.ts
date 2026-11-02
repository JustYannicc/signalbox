import { expect } from "vite-plus/test";
import {
  assertQualifierClaudeFacetConfiguration,
  assertQualifierClaudeNativeFacetConfiguration,
} from "./facetEnvironmentContract.ts";

export function assertInertClaudeFacetIsolation(runtime: Readonly<Record<string, unknown>>) {
  const inert = {
    ...Object.fromEntries(
      Object.entries(runtime).filter(
        ([key]) => !key.startsWith("HARNESS_RESUME_") && key !== "HARNESS_REQUEST_PUBLISHER",
      ),
    ),
    QUALIFIER_CLAUDE_FACET_MODE: "inert-import-calibration",
  };
  expect(() => assertQualifierClaudeFacetConfiguration(inert)).not.toThrow();
  expect(() => assertQualifierClaudeNativeFacetConfiguration(inert)).toThrow(
    "HARNESS_RESUME_RUN_ID",
  );
  const unmarked = Object.fromEntries(
    Object.entries(inert).filter(([key]) => key !== "QUALIFIER_CLAUDE_FACET_MODE"),
  );
  expect(() => assertQualifierClaudeFacetConfiguration(unmarked)).toThrow("HARNESS_RESUME_RUN_ID");
  for (const key of [
    "HARNESS_RESUME_RUN_ID",
    "HARNESS_RESUME_CONTROL",
    "HARNESS_RESUME_RUN_STORE",
    "HARNESS_RESUME_FILES_STORE",
    "HARNESS_RESUME_SUPERVISOR",
    "HARNESS_RESUME_CREATION",
    "HARNESS_RESUME_PUBLISHER",
    "HARNESS_REQUEST_PUBLISHER",
  ]) {
    expect(() =>
      assertQualifierClaudeFacetConfiguration({
        ...inert,
        [key]: "forbidden-authority",
      }),
    ).toThrow(key);
  }
  expect(() =>
    assertQualifierClaudeFacetConfiguration({
      ...inert,
      QUALIFIER_CLAUDE_FACET_MODE: "unknown",
    }),
  ).toThrow("QUALIFIER_CLAUDE_FACET_MODE");
}
