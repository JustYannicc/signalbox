import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import {
  ReleaseOmissionConfiguration,
  type ReleaseOmissionConfiguration as ReleaseOmissionConfigurationType,
} from "@t3tools/contracts/harnessReleaseOmission";
import {
  parseReleaseCoverageCorpus,
  type ReleaseOmissionOptions,
} from "../claude-bunfs/release-omission.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeConfiguration = Schema.decodeUnknownSync(ReleaseOmissionConfiguration, {
  onExcessProperty: "error",
});

async function readHostConfiguration(name: string): Promise<ReleaseOmissionConfigurationType> {
  const entry = NodeURL.fileURLToPath(
    new URL("../../apps/cloud/infra/claudeTurnProof/hostConfiguration.ts", import.meta.url),
  );
  const { stdout } = await execFile(process.execPath, ["--experimental-strip-types", entry, name], {
    cwd: NodePath.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("CLAUDE_HOST_CONFIGURATION_INVALID", { cause });
  }
  try {
    return decodeConfiguration(value);
  } catch (cause) {
    throw new Error("CLAUDE_HOST_CONFIGURATION_INVALID", { cause });
  }
}

/** Reads host values through the typed cloud infra entry without importing cloud source here. */
export async function readClaudeOmission(input: {
  readonly enabled: boolean;
  readonly corpusPath?: string;
  readonly configurationName?: string;
}): Promise<ReleaseOmissionOptions | undefined> {
  const name = input.configurationName ?? "product";
  if (name !== "product" && name !== "qualification")
    throw new Error("CLAUDE_HOST_CONFIGURATION_INVALID");
  if (!input.enabled && input.corpusPath) throw new Error("CLAUDE_OMISSION_NOT_ENABLED");
  if (!input.enabled && !input.corpusPath) {
    if (input.configurationName) throw new Error("CLAUDE_OMISSION_NOT_ENABLED");
    return undefined;
  }
  const corpus = input.corpusPath
    ? parseReleaseCoverageCorpus(JSON.parse(await NodeFSP.readFile(input.corpusPath, "utf8")))
    : undefined;
  return {
    configuration: await readHostConfiguration(name),
    ...(corpus ? { corpus } : {}),
  };
}
