import {
  QualifierPlannedConfiguration,
  decodeQualifierPlannedConfiguration,
} from "./qualification/environmentContract.ts";

/** These descriptors are consumed by the Alchemy stack, including its deferred service bindings. */
export function deploy3QualifierEnvironment(vars: Readonly<Record<string, string>>) {
  return decodeQualifierPlannedConfiguration({
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
    ...vars,
    QUALIFIER: {
      type: "durable_object_namespace",
      resourceId: "Qualifier",
      className: "QualifierProof",
    },
    CLAUDE_FIXTURES: {
      type: "durable_object_namespace",
      resourceId: "ClaudeFixtures",
      className: "QualifierClaudeFixtures",
    },
    HARNESS_RUN_STORE: {
      type: "durable_object_namespace",
      resourceId: "RunStore",
      className: "QualifierRunStore",
    },
    HARNESS_FILES_STORE: {
      type: "durable_object_namespace",
      resourceId: "FilesStore",
      className: "QualifierFilesStore",
    },
    HARNESS_THREAD_SUPERVISOR: {
      type: "durable_object_namespace",
      resourceId: "Supervisor",
      className: "QualifierSupervisor",
    },
    PLACEMENT_STORES: {
      type: "durable_object_namespace",
      resourceId: "Placement",
      className: "QualifierPlacementStore",
    },
    PROCESS_EXECUTION_SHARDS: {
      type: "durable_object_namespace",
      resourceId: "Shards",
      className: "QualifierShard",
    },
    LOADER: { type: "worker_loader" },
    PROGRAM_ASSETS: { type: "assets" },
    QUALIFIER_COMMANDS: { type: "service", entrypoint: "QualifierCommands" },
    QUALIFIER_TAIL: { type: "service", entrypoint: "QualifierTail" },
  });
}

export function materializeDeploy3QualifierEnvironment<Namespace, Loader>(
  configuration: typeof QualifierPlannedConfiguration.Type,
  platform: {
    namespace: (resourceId: string, className: string) => Namespace;
    loader: () => Loader;
  },
) {
  const env: Record<string, string | Namespace | Loader> = {};
  const services: (
    | { type: "assets"; name: string }
    | { type: "service"; name: string; entrypoint: string }
  )[] = [];
  for (const [name, binding] of Object.entries(configuration)) {
    if (typeof binding === "string") env[name] = binding;
    else if (binding !== undefined) {
      switch (binding.type) {
        case "durable_object_namespace":
          env[name] = platform.namespace(binding.resourceId, binding.className);
          break;
        case "worker_loader":
          env[name] = platform.loader();
          break;
        case "assets":
          services.push({ type: binding.type, name });
          break;
        case "service":
          services.push({ ...binding, name });
          break;
      }
    }
  }
  return { env, services };
}
