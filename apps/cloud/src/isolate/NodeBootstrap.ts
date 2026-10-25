import { createNodeBridge, installNodeBridge, type NodeBridge } from "./NodeBridge.ts";

type PersonalityGlobal = "Bun" | "process";

export interface NodeBootstrapOptions {
  readonly modules: Readonly<Record<string, object>>;
  readonly globals?: Readonly<Partial<Record<PersonalityGlobal, object>>>;
}

export function installNodePersonality(options: NodeBootstrapOptions) {
  const { bridge, restore } = createNodePersonalityInstallation(options);
  return { bridge, restore };
}

function createNodePersonalityInstallation(options: NodeBootstrapOptions) {
  const bridge = createNodeBridge(options.modules);
  if (options.globals?.process && bridge.require("process") !== options.globals.process) {
    throw new TypeError("The process global and builtin must share one host object");
  }
  const owner = installNodeBridge(bridge);
  const previous = new Map<PersonalityGlobal, PropertyDescriptor | undefined>();
  const installed = new Map<PersonalityGlobal, object>();
  try {
    for (const name of ["Bun", "process"] as const) {
      const value = options.globals?.[name];
      if (value === undefined) continue;
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      previous.set(name, descriptor);
      Object.defineProperty(globalThis, name, {
        value,
        writable: false,
        enumerable: descriptor?.enumerable ?? true,
        configurable: true,
      });
      installed.set(name, value);
    }
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Personality setup and rollback failed", {
        cause: rollbackError,
      });
    }
    throw error;
  }
  function rollback() {
    try {
      restoreGlobals(previous);
    } finally {
      owner.restore();
    }
  }
  let restored = false;
  return {
    bridge,
    rollback,
    restore() {
      if (restored) return;
      for (const [name, value] of installed) {
        if (Object.getOwnPropertyDescriptor(globalThis, name)?.value !== value) {
          throw new Error(`Node personality global ownership changed: ${name}`);
        }
      }
      owner.restore();
      restoreGlobals(previous);
      restored = true;
    },
  };
}

function restoreGlobals(previous: ReadonlyMap<PersonalityGlobal, PropertyDescriptor | undefined>) {
  const errors: unknown[] = [];
  for (const [name, descriptor] of [...previous].toReversed()) {
    try {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else if (!Reflect.deleteProperty(globalThis, name)) {
        throw new Error(`Cannot restore Node personality global: ${name}`);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Personality globals could not be restored");
}

// A release's cached facade modules retain their host objects until this Worker is discarded.
export async function bootNodeRelease<T>(
  options: NodeBootstrapOptions,
  load: (bridge: NodeBridge) => Promise<T>,
) {
  const installation = createNodePersonalityInstallation(options);
  const { bridge, restore } = installation;
  const personality = { bridge, restore };
  try {
    const release = await load(personality.bridge);
    return { release, personality };
  } catch (error) {
    try {
      installation.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Release load and rollback failed", {
        cause: rollbackError,
      });
    }
    throw error;
  }
}
