// Waits until Cloudflare serves each host its own certificate.
//
// A new Worker custom domain gets its certificate minutes after Alchemy
// creates it. Until then the edge serves the zone's Universal `*.signalbox.run`
// certificate, and browsers pool app.signalbox.run and every other preview onto
// that connection (they share the zone's IPs). Once the domain goes live,
// Cloudflare answers those pooled requests with an empty 403 instead of a 421,
// so the browser never retries: every tab on app and the other previews fails
// until the connection closes (#618). The preview is reachable as soon as
// Alchemy deploys it, but agents open it when the job succeeds, so the job
// holds off success until here.
//
//   node .github/scripts/wait-own-certificate.cjs preview-1.signalbox.run ...

const tls = require("node:tls");
const dns = require("node:dns/promises");

/** Whether `subjectAltName` (Node's "DNS:a, DNS:b" form) names `host` itself. A wildcard doesn't count. */
function namesHost(subjectAltName, host) {
  return (subjectAltName ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .includes(`dns:${host.toLowerCase()}`);
}

/** The subjectAltName the edge serves for `host`, or undefined when the handshake fails. */
function servedSubjectAltName(host, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(undefined));
    socket.on("error", () => done(undefined));
    socket.once("secureConnect", () => done(socket.getPeerCertificate().subjectaltname));
  });
}

async function waitForOwnCertificates(
  hosts,
  {
    deadlineMs,
    intervalMs = 15_000,
    resolve = (host) => dns.lookup(host),
    probe = servedSubjectAltName,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    log = console.log,
    label = (host) => host,
  },
) {
  const waiting = new Set(hosts);
  const state = new Map();
  const deadline = now() + deadlineMs;
  for (;;) {
    const served = await Promise.all(
      [...waiting].map(async (host) => {
        try {
          await resolve(host);
        } catch {
          return [host, "dns", undefined];
        }
        return [host, "certificate", await probe(host)];
      }),
    );
    for (const [host, phase, subjectAltName] of served) {
      if (namesHost(subjectAltName, host)) {
        log(`${label(host)} serves its own certificate.`);
        waiting.delete(host);
        state.delete(host);
      } else {
        state.set(host, phase);
      }
    }
    if (waiting.size === 0) return true;
    if (now() >= deadline) {
      const unresolved = [...waiting].filter((host) => state.get(host) === "dns");
      const certificatePending = [...waiting].filter((host) => state.get(host) === "certificate");
      if (unresolved.length > 0) {
        log(
          `Cloudflare has the Worker domain binding, but DNS did not resolve before the deadline: ${unresolved.map(label).join(", ")}.`,
        );
      }
      if (certificatePending.length > 0) {
        log(
          `DNS resolves, but the zone's shared certificate is still served: ${certificatePending.map(label).join(", ")}.`,
        );
      }
      return false;
    }
    await sleep(intervalMs);
  }
}

if (require.main === module) {
  const hosts = process.argv.slice(2);
  if (hosts.length === 0) throw new Error("Pass the hostnames to wait for.");
  const prNumber = process.env.PR_NUMBER;
  const labels = new Map(
    hosts.map((host, index) => [
      host,
      prNumber === undefined
        ? `Worker ${index + 1}`
        : `the #${prNumber} preview ${index === 0 ? "cloud" : "gateway"} Worker`,
    ]),
  );
  waitForOwnCertificates(hosts, {
    deadlineMs: 30 * 60_000,
    label: (host) => labels.get(host) ?? "Worker",
  }).then((ok) => {
    if (!ok) process.exitCode = 1;
  });
}

module.exports = { namesHost, servedSubjectAltName, waitForOwnCertificates };
