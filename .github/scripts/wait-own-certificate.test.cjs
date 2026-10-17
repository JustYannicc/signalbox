const assert = require("node:assert/strict");
const test = require("node:test");
const { namesHost, waitForOwnCertificates } = require("./wait-own-certificate.cjs");

const UNIVERSAL = "DNS:*.signalbox.run, DNS:signalbox.run";
const own = (host) => `DNS:signalbox.run, DNS:${host}, DNS:*.${host}`;

test("the zone's wildcard doesn't count as a host's own certificate", () => {
  assert.equal(namesHost(UNIVERSAL, "preview-1.signalbox.run"), false);
  assert.equal(namesHost(own("preview-1.signalbox.run"), "preview-1.signalbox.run"), true);
  assert.equal(namesHost(own("preview-12.signalbox.run"), "preview-1.signalbox.run"), false);
  assert.equal(namesHost(undefined, "preview-1.signalbox.run"), false);
});

function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => void (time += ms) };
}

test("waits until every host serves its own certificate", async () => {
  const served = {
    "preview-1.signalbox.run": [undefined, UNIVERSAL, own("preview-1.signalbox.run")],
    "gateway-preview-1.signalbox.run": [UNIVERSAL, own("gateway-preview-1.signalbox.run")],
  };
  const probes = [];
  const ok = await waitForOwnCertificates(Object.keys(served), {
    deadlineMs: 60_000,
    intervalMs: 10_000,
    resolve: async () => undefined,
    probe: async (host) => {
      probes.push(host);
      return served[host].shift();
    },
    log: () => {},
    ...clock(),
  });
  assert.equal(ok, true);
  // A host that's ready isn't probed again.
  assert.deepEqual(probes, [
    "preview-1.signalbox.run",
    "gateway-preview-1.signalbox.run",
    "preview-1.signalbox.run",
    "gateway-preview-1.signalbox.run",
    "preview-1.signalbox.run",
  ]);
});

test("gives up at the deadline while a host is still on the wildcard", async () => {
  const ok = await waitForOwnCertificates(["preview-1.signalbox.run"], {
    deadlineMs: 30_000,
    intervalMs: 10_000,
    resolve: async () => undefined,
    probe: async () => UNIVERSAL,
    log: () => {},
    ...clock(),
  });
  assert.equal(ok, false);
});

test("reports unresolved DNS separately from an attached domain waiting for its certificate", async () => {
  const logs = [];
  const times = clock();
  const ok = await waitForOwnCertificates(["app.example", "gateway.example"], {
    deadlineMs: 20_000,
    intervalMs: 10_000,
    resolve: async (host) => {
      if (host === "app.example") throw new Error("ENOTFOUND");
      return undefined;
    },
    probe: async () => UNIVERSAL,
    log: (message) => logs.push(message),
    ...times,
  });
  assert.equal(ok, false);
  assert.deepEqual(logs, [
    "Cloudflare has the Worker domain binding, but DNS did not resolve before the deadline: app.example.",
    "DNS resolves, but the zone's shared certificate is still served: gateway.example.",
  ]);
});
