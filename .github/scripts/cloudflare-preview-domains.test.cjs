const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertPreviewStage,
  cleanupPreviewBindings,
  detachClosedPreviewDomains,
  expectedPreviewBindings,
  managedPreviewNumber,
  verifyPreviewBindings,
} = require("./cloudflare-preview-domains.cjs");

const bindings = expectedPreviewBindings(913);
const oldBindings = cleanupPreviewBindings(913);
const domain = (binding, extra = {}) => ({
  id: `id-${binding.kind}`,
  ...binding,
  enabled: true,
  ...extra,
});

test("requires exact host, service, and zone for each preview Worker", () => {
  assert.deepEqual(
    verifyPreviewBindings(
      bindings.map((binding) => domain(binding)),
      913,
    ),
    [],
  );
  assert.deepEqual(
    verifyPreviewBindings(
      bindings.map((binding) => domain(binding, { environment: "production" })),
      913,
    ),
    [],
  );
});

test("fails when a preview binding is missing, disabled, or attached to another service", () => {
  assert.match(verifyPreviewBindings([], 913).join(" "), /cloud.*not attached/);
  assert.match(
    verifyPreviewBindings([domain(bindings[0], { enabled: false })], 913).join(" "),
    /cloud.*disabled or missing enabled state/,
  );
  assert.match(
    verifyPreviewBindings([domain(bindings[0], { enabled: undefined })], 913).join(" "),
    /cloud.*disabled or missing enabled state/,
  );
  assert.match(
    verifyPreviewBindings(
      [domain(bindings[0]), domain({ ...bindings[0], id: "duplicate-cloud" })],
      913,
    ).join(" "),
    /cloud.*duplicate Worker domain records/,
  );
  assert.match(
    verifyPreviewBindings([domain({ ...bindings[0], service: "some-other-worker" })], 913).join(
      " ",
    ),
    /cloud.*wrong Worker service/,
  );
});

test("fails when any other Worker adds a preview domain", () => {
  const extras = [
    domain({
      kind: "worker",
      hostname: "gateway.example.com",
      service: "signalbox-extra-pr-913",
      zone_id: bindings[0].zone_id,
    }),
    domain({
      kind: "worker",
      hostname: "metrics-preview-913.signalbox.run",
      service: "signalbox-metrics",
      zone_id: bindings[0].zone_id,
    }),
  ];
  for (const extra of extras) {
    assert.match(
      verifyPreviewBindings([domain(bindings[0]), extra], 913).join(" "),
      /2 Worker domain records; expected exactly one/,
    );
  }
});

test("rejects the legacy multi-domain state after a preview deploy", () => {
  assert.match(
    verifyPreviewBindings(
      oldBindings.map((binding) => domain(binding)),
      913,
    ).join(" "),
    /3 Worker domain records; expected exactly one/,
  );
});

test("refuses production or a mismatched stage before any API call", () => {
  assert.throws(
    () => assertPreviewStage("production", 913),
    /only accepts the matching PR preview stage/,
  );
  assert.throws(
    () => assertPreviewStage("pr-912", 913),
    /only accepts the matching PR preview stage/,
  );
});

test("finds app and legacy gateway/trace domains even if Cloudflare labels them production", () => {
  assert.equal(managedPreviewNumber(domain(bindings[0], { environment: "production" })), 913);
  for (const binding of oldBindings.slice(1)) {
    assert.equal(managedPreviewNumber(domain(binding, { environment: "production" })), 913);
  }
  assert.equal(
    managedPreviewNumber({
      ...domain(bindings[0]),
      service: expectedPreviewBindings(912)[0].service,
    }),
    null,
  );
});

test("deletes only the closed PR's app and legacy gateway/trace bindings", async () => {
  const production = {
    id: "production",
    hostname: "app.signalbox.run",
    service: "signalbox-cloud",
    zone_id: bindings[0].zone_id,
    enabled: true,
  };
  const otherPreview = { id: "other-preview", ...expectedPreviewBindings(914)[0] };
  let rows = [
    production,
    domain(bindings[0]),
    domain(bindings[0], { id: "duplicate-cloud" }),
    domain(oldBindings[1]),
    domain(oldBindings[2]),
    otherPreview,
  ];
  const deleted = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (init.method === "DELETE") {
      const id = url.pathname.split("/").at(-1);
      deleted.push(id);
      rows = rows.filter((row) => row.id !== id);
      return Response.json({ success: true, result: { success: true } });
    }
    return Response.json({
      success: true,
      result: rows,
      result_info: { total_pages: 1 },
    });
  };

  assert.equal(await detachClosedPreviewDomains("account", "token", 913, fetcher), 4);
  assert.deepEqual(deleted.sort(), ["duplicate-cloud", "id-cloud", "id-gateway", "id-traces"]);
  assert.deepEqual(rows, [production, otherPreview]);
});

test("does not delete a domain bound to the wrong zone or service", async () => {
  const wrong = domain({ ...bindings[0], zone_id: "production-zone" });
  const fetcher = async () =>
    Response.json({ success: true, result: [wrong], result_info: { total_pages: 1 } });
  await assert.rejects(
    detachClosedPreviewDomains("account", "token", 913, fetcher),
    /Cannot safely detach Worker domains/,
  );
});

test("discovers and deletes an orphan trace domain after its Worker is gone", async () => {
  const traces = domain(oldBindings[2], { id: "closed-traces" });
  const otherPreview = {
    ...traces,
    id: "other-traces",
    hostname: "traces-preview-914.signalbox.run",
    service: "signalbox-cloud-pr-914-traces",
  };
  const production = {
    ...traces,
    id: "production-traces",
    hostname: "traces-app.signalbox.run",
    service: "signalbox-cloud-traces",
  };
  assert.equal(managedPreviewNumber(traces), 913);
  assert.equal(managedPreviewNumber(production), null);
  assert.equal(managedPreviewNumber({ ...traces, service: otherPreview.service }), null);
  let rows = [traces, otherPreview, production];
  const deleted = [];
  const fetcher = async (input, init = {}) => {
    if (init.method === "DELETE") {
      const id = new URL(input).pathname.split("/").at(-1);
      deleted.push(id);
      rows = rows.filter((row) => row.id !== id);
      return Response.json({ success: true, result: { success: true } });
    }
    return Response.json({ success: true, result: rows, result_info: { total_pages: 1 } });
  };
  assert.equal(await detachClosedPreviewDomains("account", "token", 913, fetcher), 1);
  assert.deepEqual(deleted, [traces.id]);
  assert.deepEqual(rows, [otherPreview, production]);
});
