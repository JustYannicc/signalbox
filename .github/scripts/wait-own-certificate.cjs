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
    probe = servedSubjectAltName,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    log = console.log,
  },
) {
  const waiting = new Set(hosts);
  const deadline = now() + deadlineMs;
  for (;;) {
    const served = await Promise.all([...waiting].map(async (host) => [host, await probe(host)]));
    for (const [host, subjectAltName] of served) {
      if (namesHost(subjectAltName, host)) {
        log(`${host} serves its own certificate.`);
        waiting.delete(host);
      }
    }
    if (waiting.size === 0) return true;
    if (now() >= deadline) {
      log(`Still on the zone's shared certificate: ${[...waiting].join(", ")}`);
      return false;
    }
    await sleep(intervalMs);
  }
}

if (require.main === module) {
  const hosts = process.argv.slice(2);
  if (hosts.length === 0) throw new Error("Pass the hostnames to wait for.");
  waitForOwnCertificates(hosts, { deadlineMs: 30 * 60_000 }).then((ok) => {
    if (!ok) process.exitCode = 1;
  });
}

module.exports = { namesHost, servedSubjectAltName, waitForOwnCertificates };
