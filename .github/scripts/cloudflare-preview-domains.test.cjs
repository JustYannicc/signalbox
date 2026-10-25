const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  assertPreviewStage,
  detachClosedPreviewDomains,
  expectedPreviewBindings,
  listWorkerScripts,
  managedPreviewNumber,
  verifyPreviewBindings,
  verifyOneDomainPreviewBindings,
} = require("./cloudflare-preview-domains.cjs");

const bindings = expectedPreviewBindings(913);
const appBinding = bindings[0];
const STACK_TAG = "alchemy:stack:SignalboxCloud";
const stageScript = (service, number = 913, stack = STACK_TAG) => ({
  id: service,
  tags: [stack, `alchemy:stage:pr-${number}`],
});
const domain = (binding, extra = {}) => ({
  id: `id-${binding.kind}`,
  ...binding,
  enabled: true,
  ...extra,
});

function runVerifierCommand(
  command,
  domains,
  scripts = bindings.map(({ service }) => stageScript(service)),
  scriptStatus = 200,
) {
  const domainPayload = JSON.stringify({
    success: true,
    result: domains,
    result_info: { total_pages: 1 },
  });
  const scriptPayload = JSON.stringify({ success: true, result: scripts });
  const fetchMock = `globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (new Headers(init.headers).get("Authorization") !== "Bearer test-token") {
      return Response.json({ success: false }, { status: 401 });
    }
    if (url.pathname.endsWith("/workers/domains")) {
      process.stdout.write("domains-requested\\n");
      return Response.json(${domainPayload});
    }
    if (url.pathname.endsWith("/workers/scripts")) {
      process.stdout.write("scripts-requested\\n");
      return Response.json(${scriptPayload}, { status: ${scriptStatus} });
    }
    return Response.json({ success: false }, { status: 404 });
  };`;
  const preload = encodeURIComponent(fetchMock);
  return spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${preload}`,
      require.resolve("./cloudflare-preview-domains.cjs"),
      command,
    ],
    {
      env: {
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
        PR_NUMBER: "913",
        STAGE: "pr-913",
      },
    },
  );
}

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

test("the legacy verifier still requires both app and gateway preview domains", () => {
  assert.match(verifyPreviewBindings([domain(appBinding)], 913).join(" "), /gateway.*not attached/);
});

test("the one-domain verifier accepts exactly the enabled app preview domain", () => {
  assert.deepEqual(
    verifyOneDomainPreviewBindings([domain(appBinding)], [stageScript(appBinding.service)], 913),
    [],
  );
});

test("the one-domain verifier rejects missing, disabled, or misowned app domains", () => {
  assert.match(
    verifyOneDomainPreviewBindings([], [stageScript(appBinding.service)], 913).join(" "),
    /cloud.*not attached|0 Worker domain records; expected exactly one/,
  );
  assert.match(
    verifyOneDomainPreviewBindings(
      [
        domain({
          kind: "unknown-service",
          hostname: "new-preview-913.signalbox.run",
          service: "new-worker-pr-913",
          zone_id: appBinding.zone_id,
        }),
      ],
      [],
      913,
    ).join(" "),
    /cloud Worker domain is not attached/,
  );
  assert.match(
    verifyOneDomainPreviewBindings(
      [domain(appBinding, { enabled: false })],
      [stageScript(appBinding.service)],
      913,
    ).join(" "),
    /cloud.*disabled or missing enabled state/,
  );
  assert.match(
    verifyOneDomainPreviewBindings(
      [domain({ ...appBinding, service: "another-worker-pr-913" })],
      [],
      913,
    ).join(" "),
    /cloud hostname is attached to the wrong Worker service/,
  );
  assert.match(
    verifyOneDomainPreviewBindings(
      [domain({ ...appBinding, zone_id: "another-zone" })],
      [],
      913,
    ).join(" "),
    /cloud hostname is attached in the wrong zone/,
  );
  assert.match(
    verifyOneDomainPreviewBindings(
      [domain({ ...appBinding, hostname: "app.example.com" })],
      [stageScript(appBinding.service)],
      913,
    ).join(" "),
    /cloud Worker service has the wrong hostname/,
  );
});

test("the strict verifier counts tagged Workers even when Alchemy truncates their names", () => {
  const extra = domain({
    kind: "long-generated-name",
    hostname: "worker.example.net",
    service: "notifications-worker-0123456789abcdef",
    zone_id: appBinding.zone_id,
  });
  assert.match(
    verifyOneDomainPreviewBindings(
      [domain(appBinding), extra],
      [stageScript(appBinding.service), stageScript(extra.service)],
      913,
    ).join(" "),
    /2 Worker domain records; expected exactly one/,
  );
});

test("the strict verifier ignores another Alchemy stack with the same PR suffix", () => {
  const foreign = domain({
    kind: "foreign-stack",
    hostname: "worker.example.net",
    service: "foreign-worker-pr-913",
    zone_id: appBinding.zone_id,
  });
  assert.deepEqual(
    verifyOneDomainPreviewBindings(
      [domain(appBinding), foreign],
      [stageScript(appBinding.service), stageScript(foreign.service, 913, "alchemy:stack:Other")],
      913,
    ),
    [],
  );
});

test("the strict verifier accepts null tags on unrelated untagged Workers", () => {
  assert.deepEqual(
    verifyOneDomainPreviewBindings(
      [domain(appBinding)],
      [stageScript(appBinding.service), { id: "unrelated-worker", tags: null }],
      913,
    ),
    [],
  );
});

test("the strict verifier catches hand-named Workers on nested preview hosts", () => {
  const nested = domain({
    kind: "nested-host",
    hostname: "x.preview-913.signalbox.run",
    service: "handnamed-worker",
    zone_id: appBinding.zone_id,
  });
  assert.match(
    verifyOneDomainPreviewBindings(
      [domain(appBinding), nested],
      [stageScript(appBinding.service)],
      913,
    ).join(" "),
    /2 Worker domain records; expected exactly one/,
  );
});

test("the one-domain verifier ignores unrelated domains and other PR numbers", () => {
  const unrelated = [
    { hostname: "app.signalbox.run", service: "signalbox-cloud", zone_id: appBinding.zone_id },
    { hostname: "preview-914.signalbox.run", service: "other-worker-pr-914", zone_id: "other" },
    { hostname: "preview-9130.signalbox.run", service: "other-worker-pr-9130", zone_id: "other" },
    { hostname: "custom.example.com", service: "custom-worker", zone_id: "other" },
  ];
  assert.deepEqual(
    verifyOneDomainPreviewBindings(
      [domain(appBinding), ...unrelated],
      [stageScript(appBinding.service), stageScript("other-worker-pr-914", 914)],
      913,
    ),
    [],
  );
});

test("the strict verifier rejects incomplete script metadata", () => {
  assert.throws(
    () => verifyOneDomainPreviewBindings([domain(appBinding)], [{ tags: [STACK_TAG] }], 913),
    /incomplete script metadata/,
  );
  assert.throws(
    () =>
      verifyOneDomainPreviewBindings(
        [domain(appBinding)],
        [{ id: "worker", tags: "invalid" }],
        913,
      ),
    /invalid script tags/,
  );
});

test("the Worker Scripts API rejects responses that advertise incomplete pagination", async () => {
  const fetcher = async () =>
    Response.json({
      success: true,
      result: [{ id: appBinding.service, tags: [STACK_TAG, "alchemy:stage:pr-913"] }],
      result_info: { page: 1, total_pages: 2, total_count: 2 },
    });
  await assert.rejects(
    listWorkerScripts("account", "token", fetcher),
    /incomplete script metadata/,
  );
});

test("unknown CLI commands still fail with the supported command list", () => {
  const result = spawnSync(
    process.execPath,
    [require.resolve("./cloudflare-preview-domains.cjs"), "not-a-command"],
    {
      env: {
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr.toString(),
    /Use one of: verify, verify-one-domain, delete, list-prs\./,
  );
});

test("verify-one-domain CLI explicitly accepts app-only and rejects legacy extra domains", () => {
  const appOnly = runVerifierCommand("verify-one-domain", [domain(appBinding)]);
  assert.equal(appOnly.status, 0, appOnly.stderr.toString());
  assert.match(appOnly.stdout.toString(), /domains-requested/);
  assert.match(appOnly.stdout.toString(), /scripts-requested/);

  const legacyDomains = runVerifierCommand(
    "verify-one-domain",
    bindings.map((binding) => domain(binding)),
  );
  assert.equal(legacyDomains.status, 1);
  assert.match(legacyDomains.stderr.toString(), /2 Worker domain records; expected exactly one/);
});

test("legacy verify keeps its two-domain contract and does not fetch script metadata", () => {
  const result = runVerifierCommand(
    "verify",
    bindings.map((binding) => domain(binding)),
    [],
    403,
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(result.stdout.toString(), /domains-requested/);
  assert.doesNotMatch(result.stdout.toString(), /scripts-requested/);
});

test("verify-one-domain fails closed when the Worker Scripts API errors", () => {
  const result = runVerifierCommand("verify-one-domain", [domain(appBinding)], [], 403);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /Workers Scripts API request failed \(HTTP 403\)/);
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
