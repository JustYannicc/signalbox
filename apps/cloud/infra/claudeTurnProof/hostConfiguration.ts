// @effect-diagnostics nodeBuiltinImport:off - this typed entry is a standalone build subprocess.
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import {
  ReleaseOmissionConfiguration,
  type ReleaseOmissionConfiguration as ReleaseOmissionConfigurationType,
} from "@t3tools/contracts/harnessReleaseOmission";
import { CLAUDE_HOST_CONFIG } from "../../src/harness/ClaudeHostConfig.ts";

export type ClaudeHostConfigurationName = "product" | "qualification";

export const CLAUDE_QUALIFICATION_HOST_CONFIG = {
  name: "qualification",
  env: {
    HOME: "/home/claude",
    TMPDIR: "/tmp",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    CLAUDE_CODE_SHELL: "/bin/bash",
    USE_BUILTIN_RIPGREP: "0",
    TERM: "dumb",
    NO_COLOR: "1",
    ANTHROPIC_API_KEY: "mock-only-dummy-key",
    ANTHROPIC_BASE_URL: "http://mock.anthropic.invalid",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CI: "1",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "*",
    no_proxy: "*",
  },
} satisfies ReleaseOmissionConfigurationType;

const decodeConfiguration = Schema.decodeUnknownSync(ReleaseOmissionConfiguration, {
  onExcessProperty: "error",
});
export function selectClaudeHostConfiguration(name: string): ReleaseOmissionConfigurationType {
  const configuration =
    name === "product"
      ? CLAUDE_HOST_CONFIG
      : name === "qualification"
        ? CLAUDE_QUALIFICATION_HOST_CONFIG
        : undefined;
  if (configuration === undefined) throw new Error("CLAUDE_HOST_CONFIGURATION_INVALID");
  try {
    return decodeConfiguration(configuration);
  } catch (cause) {
    throw new Error("CLAUDE_HOST_CONFIGURATION_INVALID", { cause });
  }
}

const main = async () => {
  const name = process.argv[2];
  if (name === undefined) throw new Error("CLAUDE_HOST_CONFIGURATION_INVALID");
  process.stdout.write(`${JSON.stringify(selectClaudeHostConfiguration(name))}\n`);
};

if (process.argv[1] && (await NodeFSP.realpath(process.argv[1])) === import.meta.filename) {
  await main();
}
