import type { Mount, Storage } from "../storage.ts";
import { WasiDescriptorTable, type WasiDescriptor } from "../wasi/internal_wasi_descriptors.ts";
import { complete, runSync, type WasiCall } from "../wasi/internal_wasi_calls.ts";
import {
  normalizeMounts,
  type WasiMountedStorage,
  type WasiPathAnchor,
  type WasiPathLookup,
  type WasiPathSearchCheck,
  type WasiResolvedParent,
  type WasiResolvedPath,
  WasiPathResolver,
} from "../wasi/internal_wasi_paths.ts";
import { kernelError, runKernelSync, withKernelErrors } from "./KernelFileSystemErrors.ts";
import { deviceInfoForDescriptor, virtualDevicePath } from "./KernelVirtualDevices.ts";

export interface ResolveOptions {
  readonly followFinal?: boolean;
  readonly cwd?: string;
  readonly checkSearch?: WasiPathSearchCheck;
}

export function mountedStorageForTable(
  mounts: Mount<Storage>[],
  descriptors: WasiDescriptorTable,
): WasiMountedStorage[] {
  const normalized = withKernelErrors(() => normalizeMounts(mounts));
  const inherited = new Map<string, WasiMountedStorage>();
  for (const [, descriptor] of descriptors.entries()) {
    const mount = descriptor.mount;
    if (mount !== undefined && !inherited.has(mount.path)) inherited.set(mount.path, mount);
  }
  return normalized.map((mount) => {
    const prior = inherited.get(mount.path);
    return prior !== undefined &&
      prior.id === mount.id &&
      prior.storage === mount.storage &&
      prior.root === mount.root &&
      prior.readOnly === mount.readOnly
      ? prior
      : mount;
  });
}

export class KernelPathResolver {
  readonly mounts: readonly WasiMountedStorage[];
  readonly #byPath: readonly WasiMountedStorage[];
  readonly #resolver = new WasiPathResolver(complete, (mount, components) =>
    this.#assertResolvedMount(mount, components),
  );
  readonly #descriptors: WasiDescriptorTable;
  readonly #fallbackCwd: string;
  #cwdAnchor: WasiPathAnchor | undefined;

  constructor(
    mounts: WasiMountedStorage[],
    descriptors: WasiDescriptorTable,
    cwdAnchor?: WasiPathAnchor,
  ) {
    this.mounts = mounts;
    this.#byPath = [...mounts].sort((left, right) => right.path.length - left.path.length);
    this.#descriptors = descriptors;
    this.#cwdAnchor = cwdAnchor === undefined ? rootAnchor(mounts[0]) : copyAnchor(cwdAnchor);
    this.#fallbackCwd = mounts[0]?.path ?? "/";
  }

  get cwd(): string {
    const anchor = this.validatedCwdAnchor();
    return anchor === undefined
      ? this.#fallbackCwd
      : joinGuestPath(anchor.mount.path, anchor.pathComponents);
  }

  get cwdAnchor(): WasiPathAnchor | undefined {
    return this.#cwdAnchor === undefined ? undefined : copyAnchor(this.#cwdAnchor);
  }

  validatedCwdAnchor(): WasiPathAnchor | undefined {
    if (this.#cwdAnchor === undefined) return undefined;
    const anchor = this.#validateAnchor(this.#cwdAnchor);
    this.#cwdAnchor = copyAnchor(anchor);
    return copyAnchor(anchor);
  }

  setCwd(path: string): void {
    const resolved = this.resolve(path);
    this.setCwdFromResolved(resolved);
  }

  setCwdFromDescriptor(fd: number): void {
    const descriptor = withKernelErrors(() => this.#descriptors.get(fd));
    if (
      descriptor.kind !== "directory" ||
      descriptor.mount === undefined ||
      descriptor.inode === undefined
    ) {
      throw kernelError("ENOTDIR");
    }
    this.setCwdFromAnchor(this.#descriptorAnchor(descriptor));
  }

  setCwdFromAnchor(anchor: WasiPathAnchor): void {
    const mount = this.mounts.find((candidate) => candidate === anchor.mount);
    if (mount === undefined)
      throw kernelError("EXDEV", "Working directory is outside the mounted filesystem");
    const validated = this.#validateAnchor({ ...anchor, mount });
    const stat = runKernelSync(mount.storage.stat(validated.inode));
    if (stat.type !== "directory") throw kernelError("ENOTDIR");
    this.#cwdAnchor = copyAnchor(validated);
  }

  setCwdFromResolved(resolved: WasiResolvedPath): void {
    if (resolved.stat.type !== "directory") throw kernelError("ENOTDIR");
    this.setCwdFromAnchor({
      mount: resolved.mount,
      inode: resolved.inode,
      ancestors: resolved.ancestors,
      pathComponents: resolved.pathComponents,
    });
  }

  resolve(path: string, options: ResolveOptions = {}): WasiResolvedPath {
    const context = this.#context(path, options.cwd);
    const resolved = this.#run(
      this.#resolver.resolve(
        context.anchor,
        context.relative,
        options.followFinal ?? true,
        this.#searchCheck(path, context.relative, options.checkSearch),
      ),
    );
    this.#assertResolvedMount(resolved.mount, resolved.pathComponents);
    return resolved;
  }

  resolveFromAnchor(anchor: WasiPathAnchor, path: string, followFinal = true): WasiResolvedPath {
    const resolved = this.#run(this.#resolver.resolve(anchor, path, followFinal));
    this.#assertResolvedMount(resolved.mount, resolved.pathComponents);
    return resolved;
  }

  resolveOrCreate(path: string, options: ResolveOptions = {}): WasiPathLookup {
    const context = this.#context(path, options.cwd);
    const lookup = this.#run(
      this.#resolver.resolveOrCreate(
        context.anchor,
        context.relative,
        options.followFinal ?? true,
        this.#searchCheck(path, context.relative, options.checkSearch),
      ),
    );
    if (lookup.kind === "existing") {
      this.#assertResolvedMount(lookup.path.mount, lookup.path.pathComponents);
    } else {
      this.#assertResolvedMount(lookup.parent.mount, lookup.parent.pathComponents);
    }
    return lookup;
  }

  #searchCheck(
    path: string,
    relative: string,
    check?: WasiPathSearchCheck,
  ): WasiPathSearchCheck | undefined {
    // A mount root becomes "." internally, but does not traverse a literal dot entry.
    return relative === "." && !/(^|\/)\.$/.test(path) ? undefined : check;
  }

  resolveParent(
    path: string,
    options: Omit<ResolveOptions, "followFinal"> = {},
  ): WasiResolvedParent {
    const context = this.#context(path, options.cwd);
    const parent = this.#run(this.#resolver.resolveParent(context.anchor, context.relative));
    this.#assertResolvedMount(parent.mount, parent.pathComponents);
    return parent;
  }

  guestPath(path: WasiResolvedPath): string {
    return joinGuestPath(path.mount.path, path.pathComponents);
  }

  descriptorPath(descriptor: WasiDescriptor): string {
    const device = deviceInfoForDescriptor(descriptor);
    if (device !== undefined) return virtualDevicePath(device.name);
    if (descriptor.mount === undefined)
      throw kernelError("ENOTSUP", "Descriptor has no filesystem path");
    if (descriptor.kind === "directory") {
      const anchor = this.#validateAnchor(this.#descriptorAnchor(descriptor));
      return descriptor.preopenPath ?? joinGuestPath(anchor.mount.path, anchor.pathComponents);
    }

    if (descriptor.inode === undefined)
      throw kernelError("ENOTSUP", "Descriptor has no storage inode");
    const pathComponents = descriptor.pathComponents;
    if (pathComponents === undefined || pathComponents.length === 0) throw kernelError("ESTALE");
    const parent = this.#validateAnchor(this.anchorForDescriptorParent(descriptor));
    const entry = runKernelSync(parent.mount.storage.readdir(parent.inode)).find(
      (candidate) => candidate.inode === descriptor.inode,
    );
    if (entry === undefined) throw kernelError("ESTALE");
    return joinGuestPath(parent.mount.path, [...parent.pathComponents, entry.name]);
  }

  mountForPath(path: string): WasiMountedStorage {
    return this.#mountFor(path);
  }

  resolvedDescriptor(descriptor: WasiDescriptor): WasiResolvedPath {
    if (descriptor.mount === undefined || descriptor.inode === undefined) {
      throw kernelError("ENOTSUP", "Descriptor has no storage inode");
    }
    const stat = runKernelSync(descriptor.mount.storage.stat(descriptor.inode));
    return {
      mount: descriptor.mount,
      inode: descriptor.inode,
      stat,
      pathComponents: descriptor.pathComponents ?? [],
      ancestors: descriptor.ancestors ?? [descriptor.capabilityRoot ?? descriptor.inode],
    };
  }

  anchorForDescriptorParent(descriptor: WasiDescriptor): WasiPathAnchor {
    const mount = descriptor.mount;
    const ancestors = descriptor.ancestors;
    const pathComponents = descriptor.pathComponents;
    if (
      mount === undefined ||
      ancestors === undefined ||
      ancestors.length === 0 ||
      pathComponents === undefined
    ) {
      throw kernelError("ENOTSUP", "Descriptor has no parent path");
    }
    const inode = ancestors[ancestors.length - 1];
    if (inode === undefined) throw kernelError("EBADF");
    return { mount, inode, ancestors, pathComponents: pathComponents.slice(0, -1) };
  }

  #descriptorAnchor(descriptor: WasiDescriptor): WasiPathAnchor {
    const { mount, inode, ancestors, pathComponents } = descriptor;
    if (
      mount === undefined ||
      inode === undefined ||
      ancestors === undefined ||
      pathComponents === undefined
    ) {
      throw kernelError("ENOTSUP", "Descriptor has no retained path anchor");
    }
    return { mount, inode, ancestors, pathComponents };
  }

  #validateAnchor(anchor: WasiPathAnchor): WasiPathAnchor {
    return copyAnchor(this.#run(this.#resolver.validateAnchor(anchor)));
  }

  run<T>(call: WasiCall<T>): T {
    return this.#run(call);
  }

  #run<T>(call: WasiCall<T>): T {
    return withKernelErrors(() => runSync(call));
  }

  #context(path: string, cwdOverride?: string): { anchor: WasiPathAnchor; relative: string } {
    if (typeof path !== "string") throw kernelError("EINVAL");
    const absolute = path.startsWith("/");
    if (absolute) {
      const mount = this.#mountFor(path);
      return { anchor: this.#rootAnchor(mount), relative: relativeToMount(path, mount.path) };
    }
    if (cwdOverride === undefined) {
      const anchor = this.#cwdAnchor;
      if (anchor === undefined) throw kernelError("ENOENT", "No mounted working directory");
      const validated = this.#validateAnchor(anchor);
      this.#cwdAnchor = copyAnchor(validated);
      return this.#relativeMountContext(validated, path);
    }
    const mount = this.#mountFor(cwdOverride);
    return this.#relativeMountContext(this.#anchorAt(mount, cwdOverride), path);
  }

  #relativeMountContext(
    anchor: WasiPathAnchor,
    path: string,
  ): { anchor: WasiPathAnchor; relative: string } {
    const segments = path.split("/");
    if (
      anchor.pathComponents.length !== 0 ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      return { anchor: copyAnchor(anchor), relative: path };
    }

    const rootParts = mountPathParts(anchor.mount.path);
    const destination = this.#mountFor(joinGuestPath(anchor.mount.path, segments));
    if (destination === anchor.mount) return { anchor: copyAnchor(anchor), relative: path };
    const destinationParts = mountPathParts(destination.path);
    if (
      destinationParts.length !== rootParts.length + 1 ||
      !rootParts.every((part, index) => destinationParts[index] === part) ||
      segments[0] !== destinationParts[rootParts.length]
    ) {
      return { anchor: copyAnchor(anchor), relative: path };
    }
    return {
      anchor: this.#rootAnchor(destination),
      relative: segments.slice(1).join("/") || ".",
    };
  }

  #assertResolvedMount(mount: WasiMountedStorage, pathComponents: readonly string[]): void {
    const expected = this.#mountFor(joinGuestPath(mount.path, pathComponents));
    if (expected !== mount) {
      throw kernelError("ENOTCAPABLE", "Resolved path crosses a mount through an aliased path");
    }
  }

  #anchorAt(mount: WasiMountedStorage, path: string): WasiPathAnchor {
    const root = this.#rootAnchor(mount);
    const relative = relativeToMount(path, mount.path);
    if (relative === ".") return root;
    const resolved = this.#run(this.#resolver.resolve(root, relative, true));
    if (resolved.stat.type !== "directory") throw kernelError("ENOTDIR");
    return {
      mount,
      inode: resolved.inode,
      ancestors: resolved.ancestors,
      pathComponents: resolved.pathComponents,
    };
  }

  #rootAnchor(mount: WasiMountedStorage): WasiPathAnchor {
    return { mount, inode: mount.root, ancestors: [mount.root], pathComponents: [] };
  }

  #mountFor(path: string): WasiMountedStorage {
    const mount = this.#byPath.find(
      (candidate) =>
        candidate.path === "/" || path === candidate.path || path.startsWith(`${candidate.path}/`),
    );
    if (mount === undefined) throw kernelError("ENOENT", `No mount contains ${path}`);
    return mount;
  }
}

export function joinGuestPath(mountPath: string, components: readonly string[]): string {
  if (components.length === 0) return mountPath;
  const relative = components.join("/");
  return mountPath === "/" ? `/${relative}` : `${mountPath}/${relative}`;
}

function relativeToMount(path: string, mountPath: string): string {
  const relative = mountPath === "/" ? path.slice(1) : path.slice(mountPath.length);
  const cleaned = relative.replace(/^\/+/, "");
  return cleaned === "" ? "." : cleaned;
}

function rootAnchor(mount: WasiMountedStorage | undefined): WasiPathAnchor | undefined {
  return mount === undefined
    ? undefined
    : { mount, inode: mount.root, ancestors: [mount.root], pathComponents: [] };
}

function copyAnchor(anchor: WasiPathAnchor): WasiPathAnchor {
  return {
    mount: anchor.mount,
    inode: anchor.inode,
    ancestors: [...anchor.ancestors],
    pathComponents: [...anchor.pathComponents],
  };
}

function mountPathParts(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}
