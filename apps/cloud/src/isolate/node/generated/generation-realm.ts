// @effect-diagnostics nodeBuiltinImport:off - identify proxies without running guest traps.
import * as NodeUtil from "node:util";

const root = globalThis;
const own = Object.getOwnPropertyDescriptor;
const keysOf = Reflect.ownKeys;
const prototypeOf = Object.getPrototypeOf;
const setPrototypeOf = Reflect.setPrototypeOf;
const same = Object.is;
const apply = Reflect.apply;
const iteratorSymbol = Symbol.iterator;
const NativePromise = Promise;
const nativeThen = Promise.prototype.then;
const defineProperty = Object.defineProperty;
const freeze = Object.freeze;
const create = Object.create;
const promiseConstructor = freeze(
  defineProperty(create(null), Symbol.species, { value: NativePromise }),
);
const constructorDescriptor = freeze(Object.assign(create(null), { value: promiseConstructor }));
const thenDescriptor = freeze(Object.assign(create(null), { value: protectedThen }));

// Await and Promise.then consult constructor/species/then even on native promises.
// Shadow those lookups on our promises before guest work can run between awaits.
export function generatedCodePromise<T>(promise: Promise<T>): Promise<T> {
  defineProperty(promise, "constructor", constructorDescriptor);
  defineProperty(promise, "then", thenDescriptor);
  return promise;
}

function protectedThen(
  this: Promise<unknown>,
  fulfilled: ((value: unknown) => unknown) | undefined,
  rejected: ((error: unknown) => unknown) | undefined,
): Promise<unknown> {
  return generatedCodePromise(apply(nativeThen, this, [fulfilled, rejected]) as Promise<unknown>);
}
const isProxy = typeof NodeUtil.types?.isProxy === "function" ? NodeUtil.types.isProxy : undefined;

interface RealmObject {
  readonly learningOnly: boolean;
  readonly target: object;
  readonly prototype: object | null;
  readonly keys: readonly PropertyKey[];
  readonly descriptors: readonly PropertyDescriptor[];
}

function capture(target: object, learningOnly: boolean): RealmObject {
  const keys = keysOf(target);
  const descriptors: PropertyDescriptor[] = [];
  setPrototypeOf(descriptors, null);
  for (let index = 0; index < keys.length; index++) {
    const descriptor = own(target, keys[index]!)!;
    setPrototypeOf(descriptor, null);
    descriptors[index] = descriptor;
  }
  setPrototypeOf(keys, null);
  return { learningOnly, target, prototype: prototypeOf(target), keys, descriptors };
}

const bindings = [
  "Object",
  "Array",
  "Set",
  "String",
  "Reflect",
  "JSON",
  "Error",
  "Number",
  "Math",
  "TextEncoder",
  "Promise",
];
setPrototypeOf(bindings, null);

function bindingValue(name: string): object | undefined {
  let target: object | null = root;
  while (target !== null) {
    if (!isProxy || isProxy(target)) return undefined;
    const descriptor = own(target, name);
    if (descriptor) {
      setPrototypeOf(descriptor, null);
      const value = descriptor.value as unknown;
      return value !== null && (typeof value === "object" || typeof value === "function")
        ? value
        : undefined;
    }
    target = prototypeOf(target);
  }
  return undefined;
}

function captureRealm() {
  if (!isProxy) return undefined;
  try {
    const globals: object[] = [];
    const surfaces: RealmObject[] = [];
    setPrototypeOf(globals, null);
    setPrototypeOf(surfaces, null);
    const addSurface = (target: object, learningOnly = false) => {
      if (isProxy(target)) return false;
      surfaces[surfaces.length] = capture(target, learningOnly);
      return true;
    };
    // Workerd exposes some bindings on WorkerGlobalScope's prototype.
    // Missing/accessor/Proxy bindings disable this cache instead of blocking module import.
    for (let index = 0; index < bindings.length; index++) {
      const learningOnly = bindings[index] === "Promise";
      const value = bindingValue(bindings[index]!);
      if (!value || !addSurface(value, learningOnly)) return undefined;
      globals[index] = value;
      const descriptor = own(value, "prototype");
      if (descriptor) {
        setPrototypeOf(descriptor, null);
        const prototype = descriptor.value as unknown;
        if (
          prototype === null ||
          typeof prototype !== "object" ||
          !addSurface(prototype, learningOnly)
        )
          return undefined;
      }
    }
    const arrayPrototype = own(globals[1]!, "prototype")?.value as object;
    const iterator = own(arrayPrototype, iteratorSymbol)?.value as unknown;
    if (typeof iterator !== "function" || isProxy(iterator)) return undefined;
    const iteratorPrototype = prototypeOf(apply(iterator, [], []));
    if (!iteratorPrototype || !addSurface(iteratorPrototype)) return undefined;
    const parent = prototypeOf(iteratorPrototype);
    if (parent && !addSurface(parent)) return undefined;
    return { globals, surfaces };
  } catch {
    return undefined;
  }
}

// Whole descriptor sets cover the pinned generator's helpers, species,
// iterator.next and inherited indexed setters without changing vendor code.
const realm = captureRealm();

/** The upstream source generator is synchronous. Skip its optional cache work in a changed realm. */
export function generatedCodeRealmIsSafe(): boolean {
  return realmIsSafe(false);
}

// Preparation uses protected host promises and no vendor generator. Promise
// changes do not require skipping verified existing code, unlike mutable data helpers.
export function generatedCodePreparationRealmIsSafe(): boolean {
  return realmIsSafe(true);
}

function realmIsSafe(preparation: boolean): boolean {
  if (!realm || !isProxy || isProxy(root)) return false;
  for (let index = 0; index < bindings.length; index++) {
    if (preparation && bindings[index] === "Promise") continue;
    if (bindingValue(bindings[index]!) !== realm.globals[index]) return false;
  }
  for (let index = 0; index < realm.surfaces.length; index++) {
    const surface = realm.surfaces[index]!;
    if (preparation && surface.learningOnly) continue;
    if (isProxy(surface.target) || prototypeOf(surface.target) !== surface.prototype) return false;
    const keys = keysOf(surface.target);
    if (keys.length !== surface.keys.length) return false;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const key = surface.keys[keyIndex]!;
      const descriptor = own(surface.target, key);
      if (!descriptor) return false;
      setPrototypeOf(descriptor, null);
      const expected = surface.descriptors[keyIndex]!;
      if (
        !same(descriptor.value, expected.value) ||
        descriptor.get !== expected.get ||
        descriptor.set !== expected.set ||
        descriptor.writable !== expected.writable ||
        descriptor.enumerable !== expected.enumerable ||
        descriptor.configurable !== expected.configurable
      )
        return false;
    }
  }
  return true;
}
