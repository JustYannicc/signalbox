import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";

interface RpcStub {
  execute(command: unknown): Promise<unknown>;
}

interface RpcNamespace {
  getByName(name: string): RpcStub;
}

type FaultPoint = "before" | "after";

function withFault<N extends RpcNamespace>(
  namespace: N,
  point: FaultPoint,
  matches: (command: unknown) => boolean,
): N {
  let armed = true;
  return new Proxy(namespace, {
    get(target, property, receiver) {
      if (property !== "getByName") return Reflect.get(target, property, receiver);
      return (name: string) => {
        const stub = target.getByName(name);
        return new Proxy(stub, {
          get(stubTarget, stubProperty, stubReceiver) {
            if (stubProperty !== "execute")
              return Reflect.get(stubTarget, stubProperty, stubReceiver);
            return async (command: unknown) => {
              if (armed && point === "before" && matches(command)) {
                armed = false;
                throw Object.assign(new Error("Injected durable RPC failure."), {
                  code: "STORAGE",
                });
              }
              const result = await stubTarget.execute(command);
              if (armed && point === "after" && matches(command)) {
                armed = false;
                throw Object.assign(new Error("Injected lost durable RPC reply."), {
                  code: "STORAGE",
                });
              }
              return result;
            };
          },
        });
      };
    },
  });
}

export function failNextFilesBefore(
  env: WorkerdEnv,
  matches: (command: unknown) => boolean,
): WorkerdEnv {
  return { ...env, HARNESS_FILES_STORE: withFault(env.HARNESS_FILES_STORE, "before", matches) };
}

export function loseNextFilesReply(
  env: WorkerdEnv,
  matches: (command: unknown) => boolean,
): WorkerdEnv {
  return { ...env, HARNESS_FILES_STORE: withFault(env.HARNESS_FILES_STORE, "after", matches) };
}

export function loseNextSupervisorReply(
  env: WorkerdEnv,
  matches: (command: unknown) => boolean,
): WorkerdEnv {
  return {
    ...env,
    HARNESS_THREAD_SUPERVISOR: withFault(env.HARNESS_THREAD_SUPERVISOR, "after", matches),
  };
}

export function failNextSupervisorBefore(
  env: WorkerdEnv,
  matches: (command: unknown) => boolean,
): WorkerdEnv {
  return {
    ...env,
    HARNESS_THREAD_SUPERVISOR: withFault(env.HARNESS_THREAD_SUPERVISOR, "before", matches),
  };
}
