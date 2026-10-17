const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertPreviewStage,
  detachClosedPreviewDomains,
  expectedPreviewBindings,
  managedPreviewNumber,
  verifyPreviewBindings,
} = require("./cloudflare-preview-domains.cjs");

const bindings = expectedPreviewBindings(913);
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
  assert.match(verifyPreviewBindings([domain(bindings[1])], 913).join(" "), /cloud.*not attached/);
  assert.match(
    verifyPreviewBindings([domain(bindings[0], { enabled: false }), domain(bindings[1])], 913).join(
      " ",
    ),
    /cloud.*disabled or missing enabled state/,
  );
  assert.match(
    verifyPreviewBindings(
      [domain(bindings[0], { enabled: undefined }), domain(bindings[1])],
      913,
    ).join(" "),
    /cloud.*disabled or missing enabled state/,
  );
  assert.match(
    verifyPreviewBindings(
      [domain(bindings[0]), domain({ ...bindings[0], id: "duplicate-cloud" }), domain(bindings[1])],
      913,
    ).join(" "),
    /cloud.*duplicate Worker domain records/,
  );
  assert.match(
    verifyPreviewBindings(
      [domain({ ...bindings[0], service: "some-other-worker" }), domain(bindings[1])],
      913,
    ).join(" "),
    /cloud.*wrong Worker service/,
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

test("finds exact app and gateway preview domains even if Cloudflare labels them production", () => {
  assert.equal(managedPreviewNumber(domain(bindings[0], { environment: "production" })), 913);
  assert.equal(managedPreviewNumber(domain(bindings[1], { environment: "production" })), 913);
  assert.equal(
    managedPreviewNumber({
      ...domain(bindings[0]),
      service: expectedPreviewBindings(912)[0].service,
    }),
    null,
  );
});

test("deletes only the closed PR's exact app and gateway bindings", async () => {
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
    domain(bindings[1]),
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

  assert.equal(await detachClosedPreviewDomains("account", "token", 913, fetcher), 3);
  assert.deepEqual(deleted.sort(), ["duplicate-cloud", "id-cloud", "id-gateway"]);
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
  const traces = {
    id: "closed-traces",
    hostname: `traces-${bindings[0].hostname}`,
    service: `${bindings[0].service}-traces`,
    zone_id: bindings[0].zone_id,
  };
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
