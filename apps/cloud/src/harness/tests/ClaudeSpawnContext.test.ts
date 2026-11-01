import { expect, it } from "vite-plus/test";
import { createNodeBridge } from "../../isolate/NodeBridge.ts";
import { captureClaudeSpawnContext, captureClaudeSpawnDiagnostic } from "../ClaudeSpawnContext.ts";

it("preserves actual model, cwd and operating env while removing credentials from every field", () => {
  const token = "private-provider-credential";
  const bridge = createNodeBridge({
    process: {
      argv: [
        "/runtime/claude",
        "/release/cli.js",
        "--model",
        "claude-sonnet-4-6",
        "--api-key",
        token,
        "--authorization=Bearer inline-credential",
        JSON.stringify({
          env: { API_TOKEN: token },
          headers: { Authorization: "Bearer nested" },
          effort: "high",
        }),
        `https://user:password@example.invalid/api?token=${token}`,
      ],
      cwd: () => "/workspace",
      env: {
        HOME: "/home/agent",
        PATH: "/bin:/usr/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C",
        ANTHROPIC_MODEL: "claude-sonnet-4-6",
        ANTHROPIC_API_KEY: token,
        CUSTOM_CREDENTIAL: "other-secret",
      },
    },
  });
  const context = captureClaudeSpawnContext(bridge);
  expect(context.cwd).toBe("/workspace");
  expect(context.argv.slice(0, 4)).toEqual([
    "/runtime/claude",
    "/release/cli.js",
    "--model",
    "claude-sonnet-4-6",
  ]);
  expect(context.env).toMatchObject({
    HOME: "/home/agent",
    PATH: "/bin:/usr/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C",
  });
  expect(context.argv[6]).toBe("--authorization=[REDACTED]");
  const encoded = JSON.stringify(context);
  for (const secret of [token, "inline-credential", "nested", "user:password", "other-secret"])
    expect(encoded).not.toContain(secret);
  expect(context.limits.truncated).toBe(false);
});

it("redacts credentials in inline JSON settings as well as paired settings", () => {
  const context = captureClaudeSpawnContext(
    createNodeBridge({
      process: {
        argv: ["/cli", '--settings={"apiKey":"inline-json-secret","effort":"high"}'],
        env: {},
        cwd: () => "/workspace",
      },
    }),
  );
  expect(context.argv[1]).toBe('--settings={"apiKey":"[REDACTED]","effort":"high"}');
});

it("bounds the serialized UTF-8 payload and reports the original argument and env counts", () => {
  const bridge = createNodeBridge({
    process: {
      argv: Array.from({ length: 600 }, () => "λ".repeat(2_000)),
      cwd: () => "/" + "λ".repeat(2_000),
      env: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`CUSTOM_${i}`, "private"])),
    },
  });
  const context = captureClaudeSpawnContext(bridge);
  expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(32_768);
  expect(context.argv.length).toBeLessThanOrEqual(256);
  expect(Object.keys(context.env).length).toBeLessThanOrEqual(128);
  expect(context.limits).toMatchObject({ argvCount: 600, envCount: 300, truncated: true });
});

it("takes an owned snapshot of the installed process rather than its later mutations", () => {
  const process = {
    argv: ["/cli", "--model=sonnet"],
    env: { HOME: "/home/old" },
    cwd: () => "/old",
  };
  const context = captureClaudeSpawnContext(createNodeBridge({ process }));
  process.argv.push("--later");
  process.env.HOME = "/home/new";
  expect(context.argv).toEqual(["/cli", "--model=sonnet"]);
  expect(context.env.HOME).toBe("/home/old");
});

it("reserves HOME, PATH, locale and the actual model beyond optional capture limits", () => {
  const process = {
    argv: [
      "/cli",
      ...Array.from({ length: 300 }, () => "x".repeat(1_024)),
      "--model",
      "claude-opus-4-6",
    ],
    cwd: () => "/work/actual",
    env: {
      ...Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`OPTIONAL_${i}`, "private"])),
      HOME: "/home/actual",
      PATH: "/bin:/actual/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "UTF-8",
    },
  };
  const context = captureClaudeSpawnContext(createNodeBridge({ process }));
  expect(context.cwd).toBe("/work/actual");
  expect(context.env).toMatchObject({
    HOME: "/home/actual",
    PATH: "/bin:/actual/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "C.UTF-8",
    LC_CTYPE: "UTF-8",
  });
  expect(context).toMatchObject({ model: "claude-opus-4-6" });
  expect(context.limits.truncated).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(32_768);
});

it("records unavailable context without exposing a thrown credential or blocking startup", () => {
  const diagnostic = captureClaudeSpawnDiagnostic(
    createNodeBridge({
      process: {
        argv: ["/cli"],
        env: {},
        cwd: () => {
          throw new Error("private-capture-failure");
        },
      },
    }),
  );
  expect(diagnostic).toEqual({ type: "harness.cli-spawn-context", unavailable: true });
});

it("keeps required fields inside the payload cap even when JSON escapes expand them", () => {
  const context = captureClaudeSpawnContext(
    createNodeBridge({
      process: {
        argv: ["/cli", ...Array.from({ length: 300 }, () => "x".repeat(1_024)), "--model=sonnet"],
        env: { HOME: "\u0000".repeat(2_000), PATH: "\u0001".repeat(2_000), LC_ALL: "C" },
        cwd: () => "/work",
      },
    }),
  );
  expect(Object.keys(context.env)).toEqual(["HOME", "PATH", "LC_ALL"]);
  expect(context.model).toBe("sonnet");
  expect(context.env.LC_ALL).toBe("C");
  expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(32_768);
});
