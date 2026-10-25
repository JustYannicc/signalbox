// @effect-diagnostics nodeBuiltinImport:off - build-time preparation for the shared workerd proof.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

async function bundle(entryPoint: string, outputName: string): Promise<string> {
  const result = await Esbuild.build({
    entryPoints: [entryPoint],
    outfile: outputName,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error(`Node network proof bundle was empty: ${outputName}`);
  return source;
}

export async function prepareNodeNetworkProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const bootstrapPath = NodeURL.fileURLToPath(
    new URL("../../src/isolate/NodeBootstrap.ts", import.meta.url),
  );
  const networkPath = NodeURL.fileURLToPath(
    new URL("../../src/isolate/NodeNetwork.ts", import.meta.url),
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "runtime-bootstrap.js"),
    await bundle(bootstrapPath, "runtime-bootstrap.js"),
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "runtime-network.js"),
    await bundle(networkPath, "runtime-network.js"),
  );

  const layer = createNodeBridgeLayerModules(["http", "https", "net", "tls"]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "release-fixture.js",
      contents: `import http, {request as requestHttp} from 'node:http';
import * as httpNamespace from 'http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {Buffer} from 'node:buffer';
const cjsHttp = require('http');
const cjsNet = require('node:net');

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => { server.removeListener('error', reject); resolve(server.address().port); });
});
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const read = stream => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
  stream.once('error', reject);
  stream.once('end', () => resolve(Buffer.concat(chunks)));
});
const request = (module, options, body) => new Promise((resolve, reject) => {
  const outgoing = module.request(options, incoming => read(incoming).then(bytes => resolve({statusCode: incoming.statusCode, bytes}), reject));
  outgoing.once('error', reject);
  outgoing.end(body);
});

export async function check() {
  const identity = http === cjsHttp && cjsHttp === httpNamespace.default &&
    requestHttp === http.request && net === cjsNet && https.default === https && tls.default === tls;

  const server = http.createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = Object.create(null);
    headers['content-type'] = 'application/octet-stream';
    outgoing.writeHead(201, headers);
    outgoing.end(Buffer.concat([...chunks, Buffer.from([0, 255])]));
  });
  const port = await listen(server);
  const payload = Buffer.from([0, 255, 1, 2]);
  const response = await request(http, {host:'127.0.0.1', port, path:'/binary', method:'POST'}, payload);
  await close(server);

  const replacement = http.createServer((_incoming, outgoing) => outgoing.end('replacement'));
  const fixedPort = port;
  const oldServer = http.createServer((_incoming, outgoing) => outgoing.end('old'));
  oldServer.listen(fixedPort);
  await new Promise((resolve, reject) => {
    oldServer.once('error', reject);
    oldServer.once('listening', () => { oldServer.removeListener('error', reject); resolve(); });
  });
  const oldClosed = close(oldServer);
  replacement.listen(fixedPort);
  await new Promise((resolve, reject) => {
    replacement.once('error', reject);
    replacement.once('listening', () => { replacement.removeListener('error', reject); resolve(); });
  });
  await oldClosed;
  const replacementResponse = await request(http, {host:'localhost', port:fixedPort, path:'/'}, undefined);
  await close(replacement);

  const netOccupant = net.createServer();
  const netPort = await listen(netOccupant);
  const otherHttp = http.createServer((_incoming, outgoing) => outgoing.end('other'));
  const otherHttpPort = await listen(otherHttp);
  const conflict = http.createServer();
  const crossProtocolConflict = await new Promise(resolve => {
    conflict.once('error', error => resolve(error.code));
    conflict.listen(netPort);
  });
  await close(netOccupant);
  await close(otherHttp);

  const httpsServer = https.createServer((_incoming, outgoing) => outgoing.end('logical-https'));
  const httpsPort = await listen(httpsServer);
  const logicalHttps = await request(https, {host:'localhost', port:httpsPort, path:'/'}, undefined);
  await close(httpsServer);

  let requestReceived;
  let requestAbortedResolve;
  const requestSeen = new Promise(resolve => { requestReceived = resolve; });
  const requestAborted = new Promise(resolve => { requestAbortedResolve = resolve; });
  const cancellationServer = http.createServer((incoming, _outgoing) => {
    requestReceived();
    incoming.once('aborted', () => requestAbortedResolve(true));
  });
  const cancellationPort = await listen(cancellationServer);
  const cancelledRequest = http.request({host:'127.0.0.1', port:cancellationPort, method:'POST'});
  cancelledRequest.once('error', () => {});
  cancelledRequest.write(Buffer.from([1, 2, 3]), () => {});
  await requestSeen;
  cancelledRequest.destroy();
  const httpCancellationAborted = await requestAborted;
  await close(cancellationServer);

  let firstConcurrentSeenResolve;
  let secondConcurrentSeenResolve;
  let releaseConcurrentResponses;
  let firstConcurrentAborted = false;
  let secondConcurrentAborted = false;
  let privateRequestMarkerLeaked = false;
  const firstConcurrentSeen = new Promise(resolve => { firstConcurrentSeenResolve = resolve; });
  const secondConcurrentSeen = new Promise(resolve => { secondConcurrentSeenResolve = resolve; });
  const concurrentResponseGate = new Promise(resolve => { releaseConcurrentResponses = resolve; });
  const concurrentCancellationServer = http.createServer(async (incoming, outgoing) => {
    privateRequestMarkerLeaked ||= Object.keys(incoming.headers).some(name => name.startsWith('x-signalbox-local-'));
    if (incoming.url === '/first') {
      firstConcurrentSeenResolve();
      incoming.once('aborted', () => { firstConcurrentAborted = true; });
      await concurrentResponseGate;
      if (!outgoing.destroyed) outgoing.end('first-released');
      return;
    }
    secondConcurrentSeenResolve();
    incoming.once('aborted', () => { secondConcurrentAborted = true; });
    await concurrentResponseGate;
    if (!outgoing.destroyed) outgoing.end('second-survived');
  });
  const concurrentCancellationPort = await listen(concurrentCancellationServer);
  const firstConcurrentRequest = http.request({
    host:'127.0.0.1', port:concurrentCancellationPort, path:'/first', method:'POST'
  });
  firstConcurrentRequest.once('error', () => {});
  let secondConcurrentRequest;
  const secondConcurrentResponsePromise = new Promise((resolve, reject) => {
    secondConcurrentRequest = http.request({
      host:'127.0.0.1', port:concurrentCancellationPort, path:'/second', method:'POST'
    }, incoming => read(incoming).then(bytes => resolve(bytes.toString()), reject));
    secondConcurrentRequest.once('error', reject);
  });
  firstConcurrentRequest.end(Buffer.from([1]));
  secondConcurrentRequest.end(Buffer.from([2]));
  await Promise.all([firstConcurrentSeen, secondConcurrentSeen]);
  const firstConcurrentClosed = new Promise(resolve => firstConcurrentRequest.once('close', resolve));
  firstConcurrentRequest.destroy();
  await firstConcurrentClosed;
  releaseConcurrentResponses();
  let secondConcurrentBody;
  try { secondConcurrentBody = await secondConcurrentResponsePromise; }
  catch { secondConcurrentBody = 'request-failed'; }
  const firstConcurrentAbortedCorrectly = firstConcurrentAborted;
  await close(concurrentCancellationServer);

  const missing = await new Promise(resolve => {
    const outgoing = http.request({host:'127.0.0.1', port:65000, path:'/miss'});
    outgoing.once('error', error => resolve({code:error.code}));
    outgoing.end();
  });

  let tlsExistingSocketUnsupported = false;
  const rawServer = net.createServer({allowHalfOpen:true}, socket => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.once('end', () => socket.end(Buffer.concat([...chunks, Buffer.from([7, 0, 255])])));
  });
  const rawPort = await listen(rawServer);
  const rawResponse = await new Promise((resolve, reject) => {
    const chunks = [];
    const client = net.connect(rawPort, '127.0.0.1');
    client.once('error', reject);
    client.on('data', chunk => chunks.push(Buffer.from(chunk)));
    client.once('end', () => resolve(Buffer.concat(chunks)));
    client.once('connect', () => {
      try { tls.connect({socket:client}); }
      catch (error) {
        tlsExistingSocketUnsupported = error.code === 'ENOTSUP' &&
          error.message.includes('TLS upgrades over existing Node sockets') &&
          !error.message.includes('loopback');
      }
      client.end(Buffer.from([0, 255, 3]));
    });
  });
  await close(rawServer);

  let tlsServerUnsupported = false;
  let tlsConstructorUnsupported = false;
  let tlsConnectUnsupported = false;
  let tlsPositionalHostOptionsUnsupported = false;
  let tlsUndefinedMiddleOptionsUnsupported = false;
  try { tls.createServer(); } catch (error) { tlsServerUnsupported = error.code === 'ENOTSUP'; }
  try { new tls.Server(); } catch (error) { tlsConstructorUnsupported = error.code === 'ENOTSUP'; }
  try { tls.connect({host:'127.0.0.1', port:rawPort}); } catch (error) { tlsConnectUnsupported = error.code === 'ENOTSUP'; }
  // The final options force loopback even when positional arguments name a remote host.
  try {
    tls.connect(443, 'example.com', {host:'127.0.0.1'});
  } catch (error) {
    tlsPositionalHostOptionsUnsupported = error.code === 'ENOTSUP' &&
      error.message.includes('TLS handshakes to loopback listeners');
  }
  try {
    tls.connect(443, undefined, {host:'127.0.0.1'});
  } catch (error) {
    tlsUndefinedMiddleOptionsUnsupported = error.code === 'ENOTSUP' &&
      error.message.includes('TLS handshakes to loopback listeners');
  }

  return {
    ok: identity && response.statusCode === 201 &&
      response.bytes.equals(Buffer.from([0, 255, 1, 2, 0, 255])) &&
      replacementResponse.bytes.toString() === 'replacement' &&
      netPort !== otherHttpPort && crossProtocolConflict === 'EADDRINUSE' &&
      logicalHttps.bytes.toString() === 'logical-https' && httpCancellationAborted === true &&
      firstConcurrentAbortedCorrectly === true && secondConcurrentBody === 'second-survived' &&
      secondConcurrentAborted === false && !privateRequestMarkerLeaked &&
      missing.code === 'ECONNREFUSED' &&
      rawResponse.equals(Buffer.from([0, 255, 3, 7, 0, 255])) &&
      tlsServerUnsupported && tlsConstructorUnsupported && tlsConnectUnsupported &&
      tlsExistingSocketUnsupported && tlsPositionalHostOptionsUnsupported &&
      tlsUndefinedMiddleOptionsUnsupported,
    identity,
    requestBytes: Array.from(response.bytes),
    replacementBytes: Array.from(replacementResponse.bytes),
    crossProtocolConflict,
    logicalHttpsBytes: Array.from(logicalHttps.bytes),
    httpCancellationAborted,
    concurrentCancellation: {
      firstAborted: firstConcurrentAbortedCorrectly,
      secondBody: secondConcurrentBody,
      secondAborted: secondConcurrentAborted,
      privateRequestMarkerLeaked,
    },
    loopbackMiss: missing,
    rawNetBytes: Array.from(rawResponse),
    tlsServerUnsupported,
    tlsConstructorUnsupported,
    tlsConnectUnsupported,
    tlsPositionalHostOptionsUnsupported,
    tlsUndefinedMiddleOptionsUnsupported,
    tlsExistingSocketUnsupported,
    note:'This fixture covers loopback behavior only: local HTTPS is logical Fetch dispatch without TLS; remote Node HTTP/net and TLS handshakes are not exercised. Raw HTTP-over-net parsing, TLS upgrades over existing Node sockets, and TLS server handshakes are unsupported.'
  };
}`,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "node-network-facades",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(layer, args.path)) return { path: args.path, namespace: "layer" };
            if (args.path === "node:buffer") return { path: args.path, external: true };
            throw new Error(`Unexpected release import: ${args.path}`);
          });
          build.onLoad({ filter: /.*/, namespace: "layer" }, (args) => ({
            contents: layer[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  const releaseSource = release.outputFiles?.[0]?.text;
  if (!releaseSource) throw new Error("Node network release bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseSource);

  const main = `import {DurableObject} from 'cloudflare:workers';
import {httpServerHandler} from 'cloudflare:node';
import {connect as connectSocket} from 'cloudflare:sockets';
import {bootNodeRelease} from './runtime-bootstrap.js';
import {createNodeNetworkModules} from './runtime-network.js';
export class NodeNetworkFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = bootNodeRelease({modules:createNodeNetworkModules({httpServerHandler,connectSocket,env,ctx})}, () => import('./release.js'));
  }
  async fetch() {
    try {
      const {release} = await this.ready;
      const result = await release.check();
      return Response.json(result, {status:result.ok ? 200 : 500});
    } catch(error) {
      return Response.json({ok:false,error:String(error)}, {status:500});
    }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-network-loopback-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeNetworkFacet",
        compatibilityDate: "2026-10-01",
        compatibilityFlags: [
          "nodejs_compat",
          "enable_nodejs_http_server_modules",
          "streams_enable_constructors",
          "transformstream_enable_standard_constructor",
        ],
        modules: Object.fromEntries(
          ["main.js", "runtime-bootstrap.js", "runtime-network.js", "release.js"].map((path) => [
            path,
            { path, type: "js" },
          ]),
        ),
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  await prepareNodeNetworkProof(NodePath.resolve(destination));
}
