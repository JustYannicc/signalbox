import { describe, expect, it } from "vite-plus/test";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";

import {
  addSubfolderSecretName,
  planSecretsSave,
  resetSubfolderSecretNamesForEnvironment,
  setSubfolderSecretIncluded,
} from "./folderSecrets.ts";

describe("subfolder secret names", () => {
  it("adds trimmed, valid names once and leaves invalid or blank input alone", () => {
    const current = ["API_TOKEN"];

    expect(addSubfolderSecretName(current, " DEPLOY_KEY ")).toEqual(["API_TOKEN", "DEPLOY_KEY"]);
    expect(addSubfolderSecretName(current, "API_TOKEN")).toBe(current);
    expect(addSubfolderSecretName(current, "bad-name")).toBe(current);
    expect(addSubfolderSecretName(current, "   ")).toBe(current);
    expect(current).toEqual(["API_TOKEN"]);
  });

  it("can turn an included name off and back on without changing the source list", () => {
    const current = ["API_TOKEN", "DATABASE_URL"];
    const disabled = setSubfolderSecretIncluded(current, "API_TOKEN", false);

    expect(disabled).toEqual(["DATABASE_URL"]);
    expect(setSubfolderSecretIncluded(disabled, "API_TOKEN", true)).toEqual([
      "DATABASE_URL",
      "API_TOKEN",
    ]);
    expect(current).toEqual(["API_TOKEN", "DATABASE_URL"]);
  });

  it("keeps names for the same Environment and clears them when the source changes", () => {
    const names = ["DEPLOY_KEY"];

    expect(resetSubfolderSecretNamesForEnvironment(" old-env ", "old-env", names)).toBe(names);
    expect(resetSubfolderSecretNamesForEnvironment("old-env", "new-env", names)).toEqual([]);
  });
});

describe("planSecretsSave", () => {
  const current = {
    environmentId: OnePasswordEnvironmentId.make("old-env"),
    includeSubfolders: ["DEPLOY_KEY"],
  };

  it("starts with an empty allowlist when the Environment changes", () => {
    expect(
      planSecretsSave({
        current,
        environmentId: "new-env",
        token: null,
        connected: true,
      }),
    ).toEqual({
      connect: null,
      secrets: { environmentId: "new-env", includeSubfolders: [] },
    });
  });

  it("keeps the allowlist when the Environment stays the same", () => {
    expect(
      planSecretsSave({ current, environmentId: "old-env", token: null, connected: true }),
    ).toEqual({ connect: null });
  });

  it("saves per-key changes and removes the source with its allowlist", () => {
    expect(
      planSecretsSave({
        current,
        environmentId: "old-env",
        includeSubfolders: [],
        token: null,
        connected: true,
      }),
    ).toEqual({
      connect: null,
      secrets: { environmentId: "old-env", includeSubfolders: [] },
    });
    expect(planSecretsSave({ current, environmentId: "", token: null, connected: true })).toEqual({
      connect: null,
      secrets: null,
    });
  });

  it("refuses names that cannot be environment variables", () => {
    expect(
      planSecretsSave({
        current: null,
        environmentId: "new-env",
        includeSubfolders: ["not-a-name"],
        token: null,
        connected: true,
      }),
    ).toHaveProperty("error");
  });
});
