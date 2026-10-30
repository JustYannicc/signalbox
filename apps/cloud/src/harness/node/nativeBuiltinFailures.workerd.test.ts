// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercise the default modules in local Workerd.
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { createTestHarness } from "wrangler";

const decodeDebuglogResponse = Schema.decodeUnknownSync(
  Schema.Struct({
    lines: Schema.Array(Schema.String),
    pid: Schema.Number,
    capability: Schema.Struct({ status: Schema.String }),
  }),
);

it("replaces Workerd placeholders and missing exports with declared named failures", async () => {
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: "node-builtin-named-failures",
          main: NodeURL.fileURLToPath(
            new URL("./tests/nativeBuiltinFailures.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat", "legacy_module_registry"],
        },
      },
    ],
  });
  try {
    await harness.listen();
    const response = await harness.fetch("http://proof/");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body);
    expect(result).toHaveLength(22);
    for (const row of result) {
      expect(row, row.builtin).toMatchObject({
        threw: true,
        code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED",
        capability: {
          status: "unsupported",
          failure: { kind: "named-error", code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" },
        },
      });
    }
    const debuglogResponse = await harness.fetch("http://proof/debuglog");
    const debuglog = decodeDebuglogResponse(await debuglogResponse.json());
    expect(debuglog.lines).toEqual([
      `GUEST-IO ${debuglog.pid}: read 7 bytes\n`,
      `LITERAL.DOT ${debuglog.pid}: included\n`,
    ]);
    expect(debuglog.capability.status).toBe("supported");
    const native = await harness.fetch("http://proof/native-behavior");
    expect(await native.json()).toEqual({
      hasGet: true,
      hasInventedMethod: false,
      duplex: "native duplex bytes",
      resolved: "/session/src",
      relative: "../b",
      pathBehavior: [
        {
          flavor: "posix",
          basename: "report",
          dirname: "/a/../b",
          extname: ".txt",
          absolute: true,
          relative: false,
          join: "b",
          normalize: "/b/report.txt",
          parse: { root: "/", dir: "/a/../b", base: "report.txt", ext: ".txt", name: "report" },
        },
        {
          flavor: "win32",
          basename: "report",
          dirname: "C:\\a\\..\\b",
          extname: ".txt",
          absolute: true,
          relative: false,
          join: "b",
          normalize: "C:\\b\\report.txt",
          parse: {
            root: "C:\\",
            dir: "C:\\a\\..\\b",
            base: "report.txt",
            ext: ".txt",
            name: "report",
          },
        },
      ],
    });
  } finally {
    await harness.close();
  }
});
