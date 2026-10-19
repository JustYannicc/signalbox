// @effect-diagnostics nodeBuiltinImport:off - Builds isolated proof modules without starting a native probe.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

export async function prepareNodeTlsRootsProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const layer = createNodeBridgeLayerModules(["tls"]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "tls-roots-release.js",
      contents: `import tls, {rootCertificates, checkServerIdentity} from 'node:tls';
import * as namespace from 'tls';
const cjs = require('node:tls');
export function check(host) {
  return tls === host && namespace.default === host && cjs === host &&
    rootCertificates === host.rootCertificates && checkServerIdentity === host.checkServerIdentity;
}`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "tls-roots-bridge",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.path in layer ? { path: args.path, namespace: "bridge" } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "bridge" }, (args) => {
            const contents = layer[args.path];
            if (contents === undefined) throw new Error("Unknown TLS bridge module");
            return { contents, loader: "js" };
          });
        },
      },
    ],
  });
  const releaseSource = release.outputFiles?.[0]?.text;
  if (!releaseSource) throw new Error("TLS roots release proof was empty");
  const worker = await Esbuild.build({
    stdin: {
      sourcefile: "tls-roots-worker.js",
      resolveDir: import.meta.dirname,
      contents: `import {DurableObject} from 'cloudflare:workers';
import {httpServerHandler} from 'cloudflare:node';
import {connect} from 'cloudflare:sockets';
import * as nativeTls from 'node:tls';
import {X509Certificate, createHash, createPublicKey} from 'node:crypto';
import {nodeRootCertificates} from '../../src/isolate/NodeTls.ts';
import {createNodeNetworkModules} from '../../src/isolate/NodeNetwork.ts';
import {installNodePersonality} from '../../src/isolate/NodeBootstrap.ts';
const tls = {...nativeTls, rootCertificates:nodeRootCertificates()};
const guestTls = createNodeNetworkModules({httpServerHandler, connectSocket:connect}).tls;
let guest;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export class TlsRootsFacet extends DurableObject {
  async fetch() {
    let phase = 'install';
    try {
    if (!guest) {
      installNodePersonality({modules:{tls:guestTls}});
      guest = await import('./release.js');
    }
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tls_root_calls (id INTEGER PRIMARY KEY, calls INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO tls_root_calls VALUES (1,1) ON CONFLICT(id) DO UPDATE SET calls=calls+1');
    const calls=this.ctx.storage.sql.exec('SELECT calls FROM tls_root_calls WHERE id=1').one().calls;
    const checks = {};
    phase = 'certificates';
    const roots = guestTls.rootCertificates;
    checks.hasActualRoots = Array.isArray(roots) && roots.length > 0;
    const certificates=roots.map(pem=>new X509Certificate(pem));
    const fingerprints=certificates.map(cert=>hash(cert.raw));
    checks.allParseableCa = certificates.length > 0 && certificates.every(cert=>cert.ca);
    checks.uniqueRoots = new Set(fingerprints).size === roots.length;
    checks.publicKeySpkiRoundTrip = certificates.every(cert => {
      const spki=cert.publicKey.export({type:'spki',format:'der'});
      const key=createPublicKey({key:spki,format:'der',type:'spki'});
      return hash(spki)===hash(key.export({type:'spki',format:'der'}));
    });
    const excluded=new Set(fingerprints.slice(0,1));
    const allowed=roots.filter(pem=>!excluded.has(hash(new X509Certificate(pem).raw)));
    checks.filterRemovesOnlySelectedRoot=allowed.length===roots.length-1 && allowed.length>0;
    checks.frozenMetadata=Object.isFrozen(roots);
    checks.sameNetworkRoots=roots===tls.rootCertificates;
    checks.nativeValidationUntouched=tls.connect===nativeTls.connect && tls.createSecureContext===nativeTls.createSecureContext &&
      tls.checkServerIdentity===nativeTls.checkServerIdentity && tls.TLSSocket===nativeTls.TLSSocket;
    checks.nativeTrustQueriesUntouched=tls.getCACertificates===nativeTls.getCACertificates;
    checks.importIdentity=guest.check(guestTls);
    return Response.json({ok:Object.values(checks).every(Boolean),calls,checks,
      rootCount:roots.length,orderedDerSha256:hash(fingerprints.join('\\n')),
      nativeRootCount:nativeTls.rootCertificates.length,nativeCaQueryAvailable:typeof nativeTls.getCACertificates==='function'});
    } catch(error) {
      return Response.json({ok:false,phase,error:{name:error.name,message:error.message,stack:error.stack}});
    }
  }
}`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    external: ["./release.js"],
    write: false,
  });
  const workerSource = worker.outputFiles?.[0]?.text;
  if (!workerSource) throw new Error("TLS roots worker proof was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "worker.js"), workerSource);
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-tls-roots",
        mode: "facet",
        mainModule: "worker.js",
        entrypoint: "TlsRootsFacet",
        modules: {
          "worker.js": { path: "worker.js", type: "js" },
          "release.js": { path: "release.js", type: "js" },
        },
        paths: ["/roots", "/roots"],
      },
      null,
      2,
    ),
  );
}
