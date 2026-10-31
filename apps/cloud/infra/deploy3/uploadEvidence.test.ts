import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { retainScriptUploadResponses } from "./uploadEvidence.ts";
import { sha256 } from "../workerStartup/payload.ts";

const origin = "https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/workload";

describe("script upload timing evidence", () => {
  it.effect("retains every success and failure body while preserving SDK decoding", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "upload-evidence-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const base = yield* HttpClient.HttpClient;
      const client = retainScriptUploadResponses(base, directory, "attempt");
      const bodies = [
        { success: true, result: { startup_time_ms: 173 } },
        { success: false, errors: [{ code: 10021, startup_time_ms: 1001 }] },
        { success: true, result: {} },
      ];
      for (const expected of bodies) {
        const response = yield* client.put(origin);
        expect(yield* response.json).toEqual(expected);
      }
      yield* client.get(`${origin}/settings`);
      const files = yield* Effect.promise(() => NodeFSP.readdir(directory));
      expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(3);
      const records = yield* Effect.promise(async () =>
        Promise.all(
          [1, 2, 3].map(async (number) => {
            const name = `attempt-${String(number).padStart(3, "0")}`;
            const raw = await NodeFSP.readFile(NodePath.join(directory, `${name}.response`));
            const record = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, `${name}.json`), "utf8"),
            );
            expect(record.response).toEqual({
              file: `${name}.response`,
              bytes: raw.length,
              sha256: sha256(raw),
            });
            expect(JSON.parse(raw.toString())).toEqual(bodies[number - 1]);
            return record;
          }),
        ),
      );
      expect(records.map((record) => record.httpStatus)).toEqual([200, 400, 200]);
      expect(records[0].startupTiming.values).toEqual([
        { path: "$.result.startup_time_ms", value: 173, unit: "ms" },
      ]);
      expect(records[1].startupTiming.values).toEqual([
        { path: "$.errors.0.startup_time_ms", value: 1001, unit: "ms" },
      ]);
      expect(records[2].startupTiming).toEqual({ status: "unavailable", values: [], headers: {} });
    }).pipe(
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        FetchHttpClient.Fetch,
        (() => {
          let call = 0;
          const bodies = [
            { success: true, result: { startup_time_ms: 173 } },
            { success: false, errors: [{ code: 10021, startup_time_ms: 1001 }] },
            { success: true, result: {} },
          ];
          return async () =>
            Response.json(bodies[call++] ?? {}, { status: call === 2 ? 400 : 200 });
        })(),
      ),
    ),
  );
});
