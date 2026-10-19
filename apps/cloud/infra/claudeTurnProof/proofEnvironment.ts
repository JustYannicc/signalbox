import * as BunJsc from "../../src/isolate/NodeBunJsc.ts";
import { createNodeEnvironmentResolver } from "../../src/isolate/NodeEnvironment.ts";
import { createNodeModule, type NodePreparedModuleResolver } from "../../src/isolate/NodeModule.ts";
import type { NodeBridge } from "../../src/isolate/NodeBridge.ts";

export interface ProofPackages {
  readonly yaml: object;
  readonly undici: object;
}

export function createProofProcessEnvironment() {
  return {
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
  };
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
