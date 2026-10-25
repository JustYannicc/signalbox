import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

const ports = vi.hoisted(() => ({
  artifactPath: "",
  artifactBytes: [] as number[],
  execFileSync: vi.fn((command: string, args: readonly string[]) =>
    command === "git" && args[0] === "rev-parse" ? "proof-commit\n" : "",
  ),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: ports.execFileSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (filePath: Parameters<typeof actual.readFile>[0]) => {
      if (String(filePath) !== ports.artifactPath) {
        throw new Error("Unexpected proof artifact read");
      }
      return Buffer.from(ports.artifactBytes);
    }),
  };
});

vi.mock("../childPrograms/basic.ts", () => ({
  prepareBasicChildPrograms: vi.fn(async () => ({
    bash: { entrypoint: "bash", modules: {} },
    busyboxCat: { entrypoint: "busybox", modules: {} },
    ripgrep: { entrypoint: "ripgrep", modules: {} },
    executableFiles: [],
  })),
}));

import { prepareProofSeed } from "./Seed.ts";

const runnerPath = NodePath.resolve(
  NodePath.resolve(import.meta.dirname, "../../../.."),
  "apps/server/dist/command-runner/command-runner.mjs",
);
const strictArgumentParser = `
import { parseArgs } from "node:util";
parseArgs({ options: { known: { type: "boolean" } }, strict: true });
`;

function useRunner(source: string) {
  ports.artifactPath = runnerPath;
  ports.artifactBytes = [...Buffer.from(source)];
}

async function expectSafePreflightFailure(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected a preflight failure");
  expect(error.message).toBe("Runner artifact preflight failed");
}

describe("prepareProofSeed Runner artifact preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.artifactPath = runnerPath;
  });

  it("accepts a standalone artifact after strict argument parsing rejects the sentinel", async () => {
    const source = `
if (process.env.SIGNALBOX_PROOF_ENV_SENTINEL !== undefined) throw new Error("Environment leaked");
${strictArgumentParser}`;
    useRunner(source);
    vi.stubEnv("SIGNALBOX_PROOF_ENV_SENTINEL", "test-only-value");
    try {
      const seed = await prepareProofSeed("unused-program-dir");
      expect(seed.sourceCommit).toBe("proof-commit");
      expect(seed.runner.sha256).toBe(NodeCrypto.createHash("sha256").update(source).digest("hex"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a missing static import before the parser can handle the sentinel", async () => {
    useRunner(`import "signalbox-proof-preflight-missing-package-r17";\n${strictArgumentParser}`);

    await expectSafePreflightFailure(prepareProofSeed("unused-program-dir"));
  });

  it("rejects when the artifact ignores the sentinel argument", async () => {
    useRunner("export {};\n");

    await expectSafePreflightFailure(prepareProofSeed("unused-program-dir"));
  });

  it("rejects startup failures other than the sentinel parser error", async () => {
    useRunner('throw new Error("unrelated startup failure");\n');

    await expectSafePreflightFailure(prepareProofSeed("unused-program-dir"));
  });
});
