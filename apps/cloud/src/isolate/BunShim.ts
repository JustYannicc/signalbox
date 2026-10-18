// Adapted from DigiBugCat/codex-wasi-agentos at 45eca7d, scripts/claude-bunfs/bun-shim.js.
// Copyright 2026 DigiBugCat. Apache-2.0; see bun/LICENSE.agentos and bun/NOTICE.agentos.
// Signalbox replaces native process/filesystem calls with isolate hosts and implements Bun hashes.
import { BunCapabilityUnavailable, type BunIsolateCapability } from "./bun/capabilities.ts";
import { createBunFiles, type BunFile, type BunFileHost } from "./bun/files.ts";
import { bunUtilities } from "./bun/utilities.ts";

export { BUN_API_CAPABILITIES, BunCapabilityUnavailable } from "./bun/capabilities.ts";
export type { BunIsolateCapability } from "./bun/capabilities.ts";
export type {
  BunFileHost,
  BunFileStat,
  BunFileTarget,
  BunFile,
  BunWriteData,
} from "./bun/files.ts";

export interface BunSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  argv0?: string;
  stdin?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  stdio?: readonly unknown[];
  detached?: boolean;
  windowsHide?: boolean;
  terminal?: unknown;
}

export interface BunSubprocess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stdin?: unknown;
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array>;
  kill(signal?: number | string): void;
  ref(): void;
  unref(): void;
}

export interface BunShimHost {
  files?: BunFileHost;
  stdin?: ReadableStream<Uint8Array>;
  env: Record<string, string | undefined>;
  main: string;
  version: string;
  revision?: string;
  embeddedFiles?: readonly BunFile[];
  which?: (command: string, options?: { PATH?: string; cwd?: string }) => string | null;
  spawn?: (command: readonly string[], options: BunSpawnOptions) => BunSubprocess;
  capabilities?: Partial<Record<BunIsolateCapability, unknown>>;
  onMissing: (member: string) => void;
}

function unavailable(member: string): never {
  throw new BunCapabilityUnavailable(member);
}

const absentFiles: BunFileHost = {
  readFile: async () => unavailable("file"),
  writeFile: async () => unavailable("write"),
  stat: async () => unavailable("file"),
  statSync: () => unavailable("file.size"),
};

function subprocessStream(stream: ReadableStream<Uint8Array> | undefined) {
  if (stream === undefined) return undefined;
  // Recent releases use both new Response(stdout).text() and stdout.text().
  return Object.assign(stream, { text: () => new Response(stream).text() });
}

export function createBunShim(host: BunShimHost) {
  const missing = new Set<string>();
  function observe<T extends object>(target: T, prefix = ""): T {
    return new Proxy(target, {
      get(object, key, receiver) {
        const value: unknown = Reflect.has(object, key)
          ? Reflect.get(object, key, receiver)
          : undefined;
        if (value !== undefined) return value;
        if (typeof key === "string") {
          const member = `${prefix}${key}`;
          if (!missing.has(member)) {
            missing.add(member);
            host.onMissing(member);
          }
        }
        return undefined;
      },
    });
  }

  const utilities = {
    ...bunUtilities,
    hash: observe(bunUtilities.hash, "hash."),
    SHA256: observe(bunUtilities.SHA256, "SHA256."),
    semver: observe(bunUtilities.semver, "semver."),
    YAML: observe(bunUtilities.YAML, "YAML."),
    TOML: observe(bunUtilities.TOML, "TOML."),
    JSONL: observe(bunUtilities.JSONL, "JSONL."),
  };
  const files = createBunFiles(
    host.files ?? absentFiles,
    host.stdin ??
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
  );
  const capability = (member: BunIsolateCapability) =>
    host.capabilities?.[member] ??
    function () {
      return unavailable(member);
    };
  const bun = observe({
    ...utilities,
    ...files,
    stdin: observe(files.stdin, "stdin."),
    env: host.env,
    main: host.main,
    version: host.version,
    revision: host.revision ?? "signalbox-workerd",
    isStandaloneExecutable: false,
    embeddedFiles: host.embeddedFiles ?? [],
    which(command: string, options?: { PATH?: string; cwd?: string }) {
      return host.which ? host.which(command, options) : unavailable("which");
    },
    spawn(
      command: readonly string[] | (BunSpawnOptions & { cmd: readonly string[] }),
      options?: BunSpawnOptions,
    ) {
      const argv = "cmd" in command ? command.cmd : command;
      const spawnOptions = "cmd" in command ? command : (options ?? {});
      if (argv.length === 0 || argv.some((arg) => typeof arg !== "string")) {
        throw new TypeError("Bun.spawn requires a nonempty command array of strings");
      }
      if (!host.spawn) return unavailable("spawn");
      const child = host.spawn(argv, spawnOptions);
      return {
        get pid() {
          return child.pid;
        },
        get exited() {
          return child.exited;
        },
        get exitCode() {
          return child.exitCode;
        },
        get stdin() {
          return child.stdin;
        },
        stdout: subprocessStream(child.stdout),
        stderr: subprocessStream(child.stderr),
        kill: child.kill.bind(child),
        ref: child.ref.bind(child),
        unref: child.unref.bind(child),
      };
    },
    gc() {},
    unsafe: observe({ setJITPolicy() {} }, "unsafe."),
    ant: observe(Object.create(null) as Record<string, unknown>, "ant."),
    sleepSync: () => unavailable("sleepSync"),
    Image: capability("Image"),
    SQL: capability("SQL"),
    Terminal: capability("Terminal"),
    Transpiler: capability("Transpiler"),
    build: capability("build"),
    serve: capability("serve"),
    listen: capability("listen"),
    connect: capability("connect"),
  });
  return {
    bun,
    get missingMembers() {
      return [...missing].sort();
    },
  };
}

export function installBunShim(host: BunShimHost) {
  const shim = createBunShim(host);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Bun");
  Object.defineProperty(globalThis, "Bun", { configurable: true, writable: true, value: shim.bun });
  return {
    bun: shim.bun,
    get missingMembers() {
      return shim.missingMembers;
    },
    restore() {
      if (Reflect.get(globalThis, "Bun") !== shim.bun) return;
      if (previous) Object.defineProperty(globalThis, "Bun", previous);
      else Reflect.deleteProperty(globalThis, "Bun");
    },
  };
}
