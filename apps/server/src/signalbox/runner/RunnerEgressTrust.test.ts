import * as NodeServices from "@effect/platform-node/NodeServices";
import { EGRESS_CA } from "@signalbox/runner-protocol/RunnerProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import { trustEgressCa } from "./RunnerEgressTrust.ts";

vi.mock("@t3tools/provider-core/server/snapshotProbe", () => ({
  spawnAndCollect: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
}));

describe("trustEgressCa", () => {
  it.effect("keeps filesystem error details out of the bundle warning", () => {
    const logs: Array<string> = [];
    const logger = Logger.map(Logger.formatJson, (line) => void logs.push(line));
    const message = "egress-ca-write-secret-canary";
    const privatePath = "private-bundle-path-canary";
    const environment: NodeJS.ProcessEnv = {};
    let writes = 0;
    const fs = FileSystem.makeNoop({
      exists: () => Effect.succeed(true),
      readFileString: (path) => Effect.succeed(path === EGRESS_CA ? "fake-ca" : "old-bundle"),
      writeFileString: () => {
        writes++;
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "writeFileString",
            pathOrDescriptor: privatePath,
            cause: new Error(message),
          }),
        );
      },
      makeDirectory: () => Effect.void,
    });
    return Effect.gen(function* () {
      yield* trustEgressCa(environment, "test-home");
      expect(writes).toBe(1);
      expect(environment.REQUESTS_CA_BUNDLE).toBeUndefined();
      expect(environment.SSL_CERT_FILE).toBeUndefined();
      expect(logs).toHaveLength(1);
      const emitted = logs.join("\n");
      expect(emitted).toContain("couldn't add the egress CA to the system bundle");
      expect(emitted).not.toContain(message);
      expect(emitted).not.toContain(privatePath);
      expect(emitted).not.toContain("PermissionDenied");
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(NodeServices.layer),
    );
  });
});
