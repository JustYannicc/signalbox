import * as BunJsc from "../../src/isolate/NodeBunJsc.ts";
import { createNodeEnvironmentResolver } from "../../src/isolate/NodeEnvironment.ts";
import { createNodeModule, type NodePreparedModuleResolver } from "../../src/isolate/NodeModule.ts";
import type { NodeBridge } from "../../src/isolate/NodeBridge.ts";
import { CLAUDE_QUALIFICATION_HOST_CONFIG } from "./hostConfiguration.ts";

export interface ProofPackages {
  readonly yaml: object;
  readonly undici: object;
}

export function createProofProcessEnvironment() {
  return { ...CLAUDE_QUALIFICATION_HOST_CONFIG.env };
}

export function createProofIdentity(prompt: string) {
  const tools = "Read,Edit,Write,Grep,Glob,Bash";
  return {
    version: "v24.18.0",
    versions: { node: "24.18.0", bun: "1.3.11" },
    platform: "linux",
    arch: "x64",
    type: "Linux",
    endianness: "LE" as const,
    availableParallelism: 1,
    user: { username: "claude", uid: 1000, gid: 1000, shell: "/bin/bash" },
    homedir: "/home/claude",
    tmpdir: "/tmp",
    pid: 100,
    ppid: 1,
    execPath: "/usr/local/bin/claude",
    argv0: "claude",
    argv: [
      "claude",
      "/$bunfs/root/cli",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      tools,
      "--tools",
      tools,
    ],
  };
}

export function createProofEnvironment(options: {
  readonly bridge: () => NodeBridge;
  readonly loadPackages: () => Promise<ProofPackages>;
  readonly onBuiltinFailure: (specifier: string) => void;
  readonly prepared?: NodePreparedModuleResolver;
}) {
  let resolver = createNodeEnvironmentResolver({
    packages: { "bun:jsc": BunJsc },
    addons: [],
    ...(options.prepared === undefined ? {} : { prepared: options.prepared }),
  });
  const module = createNodeModule(
    {
      require(specifier) {
        try {
          return options.bridge().require(specifier);
        } catch (error) {
          options.onBuiltinFailure(specifier);
          throw error;
        }
      },
    },
    (specifier, referrer) => resolver(specifier, referrer),
  );
  return {
    module,
    async load() {
      const packages = await options.loadPackages();
      // The resolver checks actual root exports instead of manufacturing package namespaces.
      resolver = createNodeEnvironmentResolver({
        packages: { ...packages, "bun:jsc": BunJsc },
        addons: [],
        ...(options.prepared === undefined ? {} : { prepared: options.prepared }),
      });
      return { packages: Object.keys(packages).sort(), bunJsc: Object.keys(BunJsc).sort() };
    },
  };
}
