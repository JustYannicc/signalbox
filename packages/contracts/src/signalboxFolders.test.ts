import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FolderSecrets } from "./signalboxFolders.ts";

const decodeFolderSecrets = Schema.decodeUnknownSync(FolderSecrets);

describe("FolderSecrets", () => {
  it("accepts only environment variable names for subfolder access", () => {
    expect(
      decodeFolderSecrets({
        environmentId: "environment-1",
        includeSubfolders: ["API_KEY", "_PRIVATE", "key2"],
      }),
    ).toEqual({
      environmentId: "environment-1",
      includeSubfolders: ["API_KEY", "_PRIVATE", "key2"],
    });

    for (const name of ["", "1API_KEY", "API-KEY", "API KEY"]) {
      expect(() =>
        decodeFolderSecrets({ environmentId: "environment-1", includeSubfolders: [name] }),
      ).toThrow();
    }
  });

  it("keeps the subfolder list optional for older folder snapshots", () => {
    expect(decodeFolderSecrets({ environmentId: "environment-1" })).toEqual({
      environmentId: "environment-1",
    });
  });
});
