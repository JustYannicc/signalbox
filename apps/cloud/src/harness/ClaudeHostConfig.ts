/** Values the Claude host enforces for every runtime launch. */
export interface ClaudeHostConfiguration {
  readonly name: string;
  readonly env: Readonly<Record<string, string | null>>;
  readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * The production host currently forwards Claude environment and settings from its caller.
 * Keep this empty until the host enforces a value for every launch.
 */
export const CLAUDE_HOST_CONFIG = {
  name: "product",
  env: {},
  settings: {},
} as const satisfies ClaudeHostConfiguration;

export const CLAUDE_PROOF_HOST_CONFIG = {
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
  settings: {},
} as const satisfies ClaudeHostConfiguration;

export const RELEASE_CHUNK_OMITTED_SYMBOL = Symbol.for("signalbox.releaseChunkOmitted");
