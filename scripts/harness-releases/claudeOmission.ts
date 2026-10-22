import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  parseReleaseCoverageCorpus,
  type ReleaseOmissionOptions,
} from "../claude-bunfs/release-omission.ts";

/** Read configuration from the host's source rather than duplicating its launch policy in the build. */
export async function readClaudeOmission(input: {
  readonly enabled: boolean;
  readonly corpusPath?: string;
  readonly configurationName?: string;
}): Promise<ReleaseOmissionOptions | undefined> {
  const name = input.configurationName ?? "product";
  if (!["product", "qualification"].includes(name))
    throw new Error("CLAUDE_HOST_CONFIGURATION_INVALID");
  if (!input.enabled && !input.corpusPath) {
    if (input.configurationName) throw new Error("CLAUDE_OMISSION_NOT_ENABLED");
    return undefined;
  }
  const corpus = input.corpusPath
    ? parseReleaseCoverageCorpus(JSON.parse(await NodeFSP.readFile(input.corpusPath, "utf8")))
    : undefined;
  const configPath = NodePath.resolve(
    import.meta.dirname,
    "../../apps/cloud/src/harness/ClaudeHostConfig.ts",
  );
  const host = (await import(NodeURL.pathToFileURL(configPath).href)) as {
    readonly CLAUDE_HOST_CONFIG: ReleaseOmissionOptions["configuration"];
    readonly CLAUDE_PROOF_HOST_CONFIG: ReleaseOmissionOptions["configuration"];
  };
  return {
    configuration:
      name === "qualification" ? host.CLAUDE_PROOF_HOST_CONFIG : host.CLAUDE_HOST_CONFIG,
    ...(corpus ? { corpus } : {}),
  };
}
