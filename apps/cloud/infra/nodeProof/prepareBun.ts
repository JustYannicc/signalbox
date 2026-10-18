// @effect-diagnostics nodeBuiltinImport:off - assembles a deployable kernel adapter proof.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

const PROOF_LIMITS = [
  "The registered child is an inline JavaScript kernel program, not a WASI binary.",
  "This proves the shared kernel, Bun and child_process adapter path; it does not run a provider CLI or a full release turn.",
];

export async function prepareNodeBunProof(destination: string): Promise<string> {
  await NodeFSP.mkdir(destination, { recursive: true });

  const sourceRoot = NodeURL.fileURLToPath(new URL("../../src/", import.meta.url));
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "bun-kernel-runtime.ts",
      resolveDir: sourceRoot,
      contents: `export {ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry} from './kernel/KernelAbi.ts';
export {KernelFileSystem, KernelOpenFlags} from './kernel/KernelFileSystem.ts';
export {KernelProgramHost} from './kernel/KernelProgramHost.ts';
export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {createNodeBunHost} from './isolate/NodeBun.ts';
export {createNodeChildProcess} from './isolate/NodeChildProcess.ts';
export {createNodeFs} from './isolate/NodeFs.ts';
export {createNodeProcess} from './isolate/NodeProcess.ts';
export {createBunShim} from './isolate/BunShim.ts';`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    write: false,
    metafile: true,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Bun kernel proof runtime bundle was empty");
  const remainingImports = Object.values(runtime.metafile?.outputs ?? {}).flatMap(
    (output) => output.imports,
  );
  const nodeImports = remainingImports.filter((item) => item.path.startsWith("node:"));
  const unresolvedImports = remainingImports.filter(
    (item) =>
      !item.external || (!item.path.startsWith("node:") && !item.path.startsWith("cloudflare:")),
  );
  if (nodeImports.length === 0 || nodeImports.some((item) => !item.external)) {
    throw new Error("Bun kernel proof must keep native node:* imports external");
  }
  if (unresolvedImports.length > 0) {
    throw new Error(
      `Bun kernel proof left non-native imports unresolved: ${unresolvedImports
        .map((item) => item.path)
        .join(", ")}`,
    );
  }
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);

  const consumerSource = `export async function runBunKernelProof(bun, childProcess, fs, processes) {
  const checks = {};
  const original = new Uint8Array([0, 255, 18, 128]);
  await bun.write('/work/shared.bin', original);
  const fd = fs.openSync('/work/shared.bin', 'r+');
  try {
    const first = new Uint8Array(1);
    const bytesRead = fs.readSync(fd, first, 0, 1, null);
    await bun.write(fd, new Uint8Array([170]));
    const remaining = await bun.file(fd).bytes();
    const stored = fs.readFileSync('/work/shared.bin');
    checks.binaryWriteRead = bytesRead === 1 && first[0] === 0 &&
      Array.from(stored).join(',') === '0,170,18,128';
    checks.sharedDescriptorOffset = Array.from(remaining).join(',') === '18,128' &&
      fs.readSync(fd, new Uint8Array(1), 0, 1, null) === 0;
  } finally {
    fs.closeSync(fd);
  }
  checks.whichUsesRelativeGuestPaths =
    bun.which('inline-tool', {PATH:'../bin', cwd:'nested'}) === '/work/bin/inline-tool';

  let missing;
  try {
    bun.spawn(['missing-tool']);
  } catch (error) {
    missing = error;
  }
  checks.missingExecutableIsEnoent = missing?.code === 'ENOENT' &&
    missing?.syscall === 'spawn' && missing?.path === 'missing-tool';

  const bunChild = bun.spawn(['inline-tool', 'bun'], {
    stderr:'pipe',
    cwd:'nested',
    env:{PATH:'../bin', HOME:'/work/home'},
    argv0:'inline-tool',
  });
  checks.bunPidIsImmediate = Number.isSafeInteger(bunChild.pid) && bunChild.pid > 1;
  if (!bunChild.stdout || !bunChild.stderr) throw new Error('Bun child pipes were unavailable');
  const bunExit = await bunChild.exited;
  const [bunStdout, bunStderr] = await Promise.all([
    new Response(bunChild.stdout).text(),
    new Response(bunChild.stderr).text(),
  ]);
  checks.bunSpawnStatusAndOutput = bunStdout === 'cwd=/work/nested;args=inline-tool,bun' &&
    bunStderr === 'inline-stderr' && bunExit === 17 && bunChild.exitCode === 17;

  const child = childProcess.spawn('/work/bin/inline-tool', ['events'], {
    cwd:'nested',
    env:{PATH:'../bin', HOME:'/work/home'},
    argv0:'inline-tool',
  });
  const pid = child.pid;
  const tableEntry = pid === undefined ? undefined : processes.lookupPid(pid);
  checks.nodePidIsImmediate = Number.isSafeInteger(pid) && pid > 1;
  checks.nodePidUsesSharedProcessTable = tableEntry?.status === 'ok' &&
    tableEntry.value.info.pid === pid;
  const events = [];
  let nodeStdout = '';
  let nodeStderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { nodeStdout += chunk; });
  child.stderr.on('data', (chunk) => { nodeStderr += chunk; });
  child.once('spawn', () => events.push('spawn'));
  child.once('exit', (code, signal) => {
    events.push('exit');
    if (code !== 17 || signal !== null) throw new Error('Node child exit status was incorrect');
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      events.push('close');
      resolve();
    });
  });
  checks.nodeAsyncEventOrder = events.join(',') === 'spawn,exit,close';
  checks.nodeChildPipes = nodeStdout === 'cwd=/work/nested;args=inline-tool,events' &&
    nodeStderr === 'inline-stderr';
  checks.inlineProgramUsedProvidedFilesystem =
    fs.readFileSync('/work/nested/child-result.txt', 'utf8') ===
      '/work/nested|inline-tool,events';
  checks.processTableReapedOnClose = pid !== undefined && processes.lookupPid(pid).status === 'error';

  return {
    ok: Object.values(checks).every(Boolean),
    proofKind: 'registered-inline-javascript-kernel-program',
    checks,
    proofLimits: ${JSON.stringify(PROOF_LIMITS)},
  };
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "consumer.js"), consumerSource);

  const mainSource = `import {DurableObject} from 'cloudflare:workers';
import {PassThrough} from 'node:stream';
import {
  ABI_VERSION,
  KernelFileSystem,
  KernelOpenFlags,
  KernelProgramHost,
  KernelProgramRegistry,
  KernelWakeRegistry,
  createFacetSqliteStorage,
  createNodeBunHost,
  createNodeChildProcess,
  createNodeFs,
  createNodeProcess,
  createBunShim,
} from './runtime.js';

const now = () => 1800000000000000000n;

export class NodeBunProofFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_bun_proof_calls(n INTEGER)');
    this.runtime = import('./consumer.js');
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/status' && path !== '/again') {
      return Response.json({
        ok:false,
        proofKind:'registered-inline-javascript-kernel-program',
        checks:{route:false},
        proofLimits:${JSON.stringify(PROOF_LIMITS)},
      }, {status:404});
    }

    const wakes = new KernelWakeRegistry();
    const filesystem = new KernelFileSystem({
      mounts:[{path:'/', storage:createFacetSqliteStorage(this.ctx.storage, now)}],
      cwd:'/',
    });
    const streams = {
      stdin:new PassThrough(),
      stdout:new PassThrough(),
      stderr:new PassThrough(),
    };
    let programHost;
    try {
      for (const path of ['/work', '/work/bin', '/work/nested', '/work/home']) {
        try {
          filesystem.mkdir(path);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
            throw error;
          }
        }
      }
      filesystem.chdir('/work');

      const registry = new KernelProgramRegistry();
      const manifest = {
        name:'inline-bun-proof',
        version:'1.0.0',
        abiVersion:ABI_VERSION,
        requiredCapabilities:['process.spawn'],
        entrypoint:'inline-bun-proof-v1',
      };
      const registration = registry.register(manifest);
      if (registration.status !== 'ok') {
        throw new Error(registration.status === 'error'
          ? registration.error.message
          : 'Inline program registration would block');
      }
      const runInline = ({filesystem:childFilesystem, args}) => {
        const stdout = childFilesystem.descriptors.get(1).stdio?.write;
        const stderr = childFilesystem.descriptors.get(2).stdio?.write;
        if (!stdout || !stderr) throw new Error('Kernel child stdio was not prepared');
        const resultFd = childFilesystem.open(
          'child-result.txt',
          KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        );
        try {
          const result = new TextEncoder().encode(
            childFilesystem.cwd + '|' + args.join(','),
          );
          childFilesystem.write(resultFd, result, null);
        } finally {
          childFilesystem.close(resultFd);
        }
        void stdout(new TextEncoder().encode(
          'cwd=' + childFilesystem.cwd + ';args=' + args.join(','),
        ));
        void stderr(new TextEncoder().encode('inline-stderr'));
        return 17;
      };
      const binding = {
        manifest,
        implementation:{kind:'javascript', runInline},
      };
      programHost = new KernelProgramHost({
        registry,
        wakes,
        programs:new Map([['/work/bin/inline-tool', binding]]),
      });
      const envVars = {PATH:'bin', HOME:'/work/home'};
      const process = createNodeProcess({
        filesystem,
        env:envVars,
        identity:{
          version:'v24.21.0',
          versions:{node:'24.21.0'},
          platform:'linux',
          arch:'x64',
          homedir:'/work/home',
          tmpdir:'/work/tmp',
          pid:1,
          ppid:0,
          execPath:'/runtime/node',
          argv0:'node',
          argv:['node','/work/main.js'],
          main:'/work/main.js',
        },
        streams,
        processes:programHost.processes,
      });
      const nodeFs = createNodeFs(filesystem);
      const childProcess = createNodeChildProcess(programHost, {
        filesystem,
        env:process.env,
        home:'/work/home',
      });
      const bun = createBunShim(createNodeBunHost({
        filesystem:nodeFs,
        process,
        childProcess,
        programHost,
        main:'/work/main.js',
        version:'1.3.2',
        revision:'node-bun-proof-v1',
        onMissing:() => {},
      })).bun;

      this.ctx.storage.sql.exec('INSERT INTO node_bun_proof_calls VALUES(1)');
      const result = await (await this.runtime).runBunKernelProof(
        bun,
        childProcess,
        nodeFs.fs,
        programHost.processes,
      );
      const calls = this.ctx.storage.sql.exec(
        'SELECT count(*) AS n FROM node_bun_proof_calls',
      ).one().n;
      const response = {
        ...result,
        calls,
        proofLimits:${JSON.stringify(PROOF_LIMITS)},
      };
      return Response.json(response, {status:result.ok ? 200 : 500});
    } catch (error) {
      return Response.json({
        ok:false,
        proofKind:'registered-inline-javascript-kernel-program',
        error:String(error),
        stack:error instanceof Error ? error.stack : undefined,
        proofLimits:${JSON.stringify(PROOF_LIMITS)},
      }, {status:500});
    } finally {
      if (programHost) await programHost.processes.dispose();
      streams.stdin.destroy();
      streams.stdout.destroy();
      streams.stderr.destroy();
      filesystem.dispose();
      wakes.dispose();
    }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), mainSource);

  const manifest = {
    id: "node-bun-kernel-adapter-proof-v1",
    mode: "facet",
    mainModule: "main.js",
    entrypoint: "NodeBunProofFacet",
    modules: Object.fromEntries(
      ["main.js", "runtime.js", "consumer.js"].map((path) => [path, { path, type: "js" }]),
    ),
    paths: ["/status", "/again"],
  };
  const manifestSource = JSON.stringify(manifest, null, 2);
  await NodeFSP.writeFile(NodePath.join(destination, "manifest.json"), manifestSource);

  const digest = NodeCrypto.createHash("sha256")
    .update([runtimeSource, consumerSource, mainSource, manifestSource].join("\0"))
    .digest("hex");
  await NodeFSP.writeFile(NodePath.join(destination, "proof.sha256"), `${digest}\n`);
  return digest;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  const digest = await prepareNodeBunProof(NodePath.resolve(destination));
  process.stdout.write(`Node Bun kernel proof artifact sha256 ${digest}\n`);
}
