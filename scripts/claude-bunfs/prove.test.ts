import { describe, expect, it } from "vite-plus/test";
import { compareMeasurements, type ProofCase } from "./prove-comparison.ts";

const graph = {
  container: "ELF",
  offsetsSize: 32,
  offset: 128,
  length: 256,
  byteCount: 208,
  flags: 0,
  entry: 0,
  recordSize: 24,
};
const serializedGraphSha256 = "a".repeat(64);
const contentsSha256 = "b".repeat(64);
const key = "__signalbox_probe__/entry.js";

function testCase(version = "2.1.302"): ProofCase {
  return {
    version,
    platform: "linux-x64",
    manifest: {
      binary: { bytes: 1024, sha256: "c".repeat(64) },
      serializedGraph: { sha256: serializedGraphSha256 },
      graph: structuredClone(graph),
      modules: [
        {
          index: 0,
          name: "entry.js",
          key,
          encoding: 0,
          loader: 1,
          format: 0,
          side: 0,
          artifacts: { contents: { sha256: contentsSha256 } },
        },
      ],
    },
  };
}

function fixtureInventory() {
  return [
    {
      name: "main.js",
      type: "js",
      bytes: 104,
      sha256: "1".repeat(64),
      path: "/tmp/fixture/main.js",
    },
    {
      name: "bun-container.js",
      type: "js",
      bytes: 208,
      sha256: "2".repeat(64),
      path: "/tmp/fixture/bun-container.js",
    },
    {
      name: "bun-graph.js",
      type: "js",
      bytes: 312,
      sha256: "3".repeat(64),
      path: "/tmp/fixture/bun-graph.js",
    },
    {
      name: "range-reader.js",
      type: "js",
      bytes: 416,
      sha256: "4".repeat(64),
      path: "/tmp/fixture/range-reader.js",
    },
  ];
}

function measurement(environment: "local-workerd" | "deployed", versions = ["2.1.302"]) {
  return {
    environment,
    verificationErrors: [],
    rows: versions.map((version) => ({
      path: `/proof?version=${version}&platform=linux-x64`,
      inventory: fixtureInventory(),
      response: {
        id: "run-claude-extractor",
        target: "facet",
        status: 200,
        result: {
          version,
          platform: "linux-x64",
          binaryUrl: "https://private-preview.workers.dev/proof",
          binaryBytes: 1024,
          serializedGraphSha256,
          graph: structuredClone(graph),
          modules: [
            {
              index: 0,
              name: "entry.js",
              key,
              encoding: 0,
              loader: 1,
              format: 0,
              side: 0,
              contentsSha256,
            },
          ],
        },
      },
    })),
  };
}

describe("compareMeasurements", () => {
  it("matches both environments and emits path-free comparison evidence", () => {
    const evidence = compareMeasurements(measurement("local-workerd"), measurement("deployed"), [
      testCase(),
    ]);
    const serialized = JSON.stringify(evidence);

    expect(evidence.status).toBe("passed");
    expect(evidence.cases[0]?.local?.modules[0]?.normalizedKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.cases[0]?.local?.inventory).toEqual(
      fixtureInventory().map(({ name, type, bytes, sha256 }) => ({ name, type, bytes, sha256 })),
    );
    expect(serialized).not.toContain("private-preview.workers.dev");
    expect(serialized).not.toContain("/tmp/fixture/");
  });

  it("rejects a worker response target in either environment", () => {
    for (const environment of ["local-workerd", "deployed"] as const) {
      const local = measurement("local-workerd");
      const deployed = measurement("deployed");
      const input = environment === "local-workerd" ? local : deployed;
      input.rows[0]!.response.target = "worker";

      const evidence = compareMeasurements(local, deployed, [testCase()]);

      expect(evidence.status).toBe("failed");
      expect(evidence.mismatches).toContain(
        `${environment === "local-workerd" ? "local" : "deployed"} 2.1.302/linux-x64: response target was not a facet.`,
      );
    }
  });

  it("rejects fixture inventory hash drift across every release row", () => {
    const versions = ["2.1.302", "2.1.303"];
    const local = measurement("local-workerd", versions);
    const deployed = measurement("deployed", versions);
    deployed.rows[1]!.inventory[2]!.sha256 = "d".repeat(64);

    const evidence = compareMeasurements(local, deployed, versions.map(testCase));

    expect(evidence.status).toBe("failed");
    expect(evidence.mismatches).toContain(
      "deployed 2.1.303/linux-x64: inventory bun-graph.js SHA-256 differs across proof rows.",
    );
    expect(evidence.cases[1]?.deployed?.inventory?.[2]?.sha256).toBe("d".repeat(64));
  });

  it("rejects missing, duplicate, and extra fixture inventory entries", () => {
    const local = measurement("local-workerd");
    const deployed = measurement("deployed");
    local.rows[0]!.inventory.splice(2, 1);
    deployed.rows[0]!.inventory.push({
      name: "bun-graph.js",
      type: "js",
      bytes: 312,
      sha256: "3".repeat(64),
      path: "/tmp/fixture/bun-graph-copy.js",
    });
    deployed.rows[0]!.inventory.push({
      name: "/tmp/fixture/unexpected.js",
      type: "js",
      bytes: 1,
      sha256: "5".repeat(64),
      path: "/tmp/fixture/unexpected.js",
    });

    const evidence = compareMeasurements(local, deployed, [testCase()]);

    expect(evidence.status).toBe("failed");
    expect(evidence.mismatches).toContain(
      "local 2.1.302/linux-x64: inventory is missing module bun-graph.js.",
    );
    expect(evidence.mismatches).toContain(
      "deployed 2.1.302/linux-x64: inventory contains duplicate module bun-graph.js.",
    );
    expect(evidence.mismatches).toContain(
      "deployed 2.1.302/linux-x64: inventory contains an unexpected module at entry 5.",
    );
    expect(JSON.stringify(evidence)).not.toContain("/tmp/fixture/");
  });

  it("rejects invalid fixture types, byte lengths, and SHA-256 values", () => {
    const local = measurement("local-workerd");
    local.rows[0]!.inventory[0]!.type = "ts";
    local.rows[0]!.inventory[1]!.bytes = Number.MAX_SAFE_INTEGER + 1;
    local.rows[0]!.inventory[2]!.sha256 = "not-a-hash";

    const evidence = compareMeasurements(local, measurement("deployed"), [testCase()]);

    expect(evidence.status).toBe("failed");
    expect(evidence.mismatches).toContain(
      "local 2.1.302/linux-x64: inventory main.js is not type js.",
    );
    expect(evidence.mismatches).toContain(
      "local 2.1.302/linux-x64: inventory bun-container.js has an invalid byte length.",
    );
    expect(evidence.mismatches).toContain(
      "local 2.1.302/linux-x64: inventory bun-graph.js has an invalid SHA-256.",
    );
  });

  it("rejects parser drift in graph bytes, normalized keys, and module contents", () => {
    const deployed = measurement("deployed");
    const result = deployed.rows[0]!.response.result as {
      serializedGraphSha256: string;
      graph: Record<string, unknown>;
      modules: { key: string; contentsSha256: string }[];
    };
    result.serializedGraphSha256 = "d".repeat(64);
    result.graph.offset = 129;
    result.modules[0]!.key = "different.js";
    result.modules[0]!.contentsSha256 = "e".repeat(64);

    const evidence = compareMeasurements(measurement("local-workerd"), deployed, [testCase()]);

    expect(evidence.status).toBe("failed");
    expect(evidence.mismatches).toContain(
      "deployed 2.1.302/linux-x64: serialized graph hash differs from the extracted artifact.",
    );
    expect(evidence.mismatches).toContain(
      "deployed 2.1.302/linux-x64: graph differs from the extracted artifact.",
    );
    expect(evidence.mismatches).toContain(
      "deployed 2.1.302/linux-x64: module 0.key differs from the extracted artifact.",
    );
    expect(evidence.mismatches).toContain(
      "deployed 2.1.302/linux-x64: module 0 contents hash differs from the extracted artifact.",
    );
  });

  it("fails transport and non-200 facet responses", () => {
    const local = measurement("local-workerd");
    local.rows[0]!.response.status = 503;
    const deployed = measurement("deployed");
    const row = deployed.rows[0]!;
    (row as { error?: string }).error = "connection failed";
    delete (row as { response?: unknown }).response;

    const evidence = compareMeasurements(local, deployed, [testCase()]);

    expect(evidence.status).toBe("failed");
    expect(evidence.mismatches).toContain(
      "local 2.1.302/linux-x64: facet response status was not 200.",
    );
    expect(evidence.mismatches).toContain(
      "deployed 2.1.302/linux-x64: measurement transport failed.",
    );
  });

  it("allows an omitted flags field only when both legacy graphs use offsetsSize 24", () => {
    const legacyCase = testCase();
    legacyCase.version = "2.1.301";
    legacyCase.manifest.graph.offsetsSize = 24;
    delete legacyCase.manifest.graph.flags;
    const legacyMeasurement = (environment: "local-workerd" | "deployed") => {
      const input = measurement(environment);
      const row = input.rows[0]!;
      row.path = "/proof?version=2.1.301&platform=linux-x64";
      const result = row.response.result as {
        version: string;
        graph: Record<string, unknown>;
      };
      result.version = "2.1.301";
      result.graph.offsetsSize = 24;
      delete result.graph.flags;
      return input;
    };

    const evidence = compareMeasurements(
      legacyMeasurement("local-workerd"),
      legacyMeasurement("deployed"),
      [legacyCase],
    );
    const currentCase = testCase();
    delete currentCase.manifest.graph.flags;

    expect(evidence.status).toBe("passed");
    expect(() =>
      compareMeasurements(measurement("local-workerd"), measurement("deployed"), [currentCase]),
    ).toThrow("graph.flags");
  });
});
