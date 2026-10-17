import { Atom, AtomRegistry } from "effect/reactivity";

export interface OptimisticScope {
  readonly accountId: string;
  readonly environmentId: string;
  readonly resourceId: string;
}

export interface OptimisticKey extends OptimisticScope {
  readonly commandId: string;
}

export type OptimisticAcknowledgment<Receipt> =
  | { readonly status: "pending" }
  | { readonly status: "acknowledged"; readonly receipt: Receipt };

export type OptimisticStatus = "pending" | "confirming" | "unknown" | "rejected";

interface OptimisticMetadata {
  readonly actionId?: string;
  readonly startedAt?: number;
}

export type OptimisticEntry<Receipt, Rejection> = OptimisticMetadata & {
  readonly key: OptimisticKey;
  readonly acknowledgment: OptimisticAcknowledgment<Receipt>;
} & (
    | { readonly status: "pending" | "confirming" | "unknown" }
    | { readonly status: "rejected"; readonly cause: Rejection }
  );

export interface OptimisticIntent<State, Receipt> extends OptimisticMetadata {
  readonly key: OptimisticKey;
  readonly project: (authoritative: State) => State;
  /** Must prove this intent is represented in authoritative data, not merely accepted. */
  readonly confirm: (
    authoritative: State,
    acknowledgment: OptimisticAcknowledgment<Receipt>,
  ) => boolean;
}

/** Call begin before authorization or scheduling; skip it for a known preflight denial. */
export function createOptimisticLedger<State, Receipt = void, Rejection = unknown>(options: {
  readonly sourceAtom: (scope: OptimisticScope) => Atom.Atom<State>;
  readonly rejectedLimit?: number;
}) {
  type Entry = OptimisticEntry<Receipt, Rejection> & { readonly token: symbol };
  type ActiveEntry = Exclude<Entry, { readonly status: "rejected" }> &
    Pick<OptimisticIntent<State, Receipt>, "project" | "confirm">;
  type StoredEntry = ActiveEntry | Extract<Entry, { readonly status: "rejected" }>;
  const rejectedLimit = options.rejectedLimit ?? 20;
  if (!Number.isSafeInteger(rejectedLimit) || rejectedLimit < 0) {
    throw new RangeError("rejectedLimit must be a non-negative safe integer");
  }

  const scopeKey = ({ accountId, environmentId, resourceId }: OptimisticScope) => ({
    accountId,
    environmentId,
    resourceId,
  });
  const entriesFamily = Atom.family((_scope: OptimisticScope) =>
    Atom.make<ReadonlyArray<StoredEntry>>([]).pipe(Atom.keepAlive),
  );
  const resource = (scope: OptimisticScope) => {
    const key = scopeKey(scope);
    return { entries: entriesFamily(key), source: options.sourceAtom(key) };
  };
  type Resource = ReturnType<typeof resource>;
  const snapshots = Atom.family((scope: OptimisticScope) => {
    const { entries, source } = resource(scope);
    return Atom.make((get) =>
      get(entries).reduce(
        (state, entry) => (entry.status === "rejected" ? state : entry.project(state)),
        get(source),
      ),
    );
  });
  const selectors = Atom.family(
    (key: OptimisticScope & { readonly status: OptimisticStatus | undefined }) => {
      const entries = entriesFamily(scopeKey(key));
      return Atom.make<ReadonlyArray<OptimisticEntry<Receipt, Rejection>>>((get) => {
        const current = get(entries);
        return key.status === undefined
          ? current
          : current.filter((entry) => entry.status === key.status);
      });
    },
  );
  const subscriptions = new WeakMap<
    AtomRegistry.AtomRegistry,
    Map<Resource["entries"], () => void>
  >();

  function stopIfIdle(registry: AtomRegistry.AtomRegistry, target: Resource) {
    if (registry.get(target.entries).some((entry) => entry.status !== "rejected")) return;
    const active = subscriptions.get(registry);
    active?.get(target.entries)?.();
    active?.delete(target.entries);
  }

  function reconcile(registry: AtomRegistry.AtomRegistry, target: Resource, state: State) {
    const previous = registry.get(target.entries);
    const next = previous.filter(
      (entry) => entry.status === "rejected" || !entry.confirm(state, entry.acknowledgment),
    );
    if (next.length !== previous.length) registry.set(target.entries, next);
    stopIfIdle(registry, target);
  }

  function observe(registry: AtomRegistry.AtomRegistry, target: Resource) {
    let active = subscriptions.get(registry);
    if (active === undefined) {
      active = new Map();
      subscriptions.set(registry, active);
    }
    if (active.has(target.entries)) return;
    const unsubscribe = registry.subscribe(target.source, (state) =>
      reconcile(registry, target, state),
    );
    active.set(target.entries, unsubscribe);
    stopIfIdle(registry, target);
  }

  function begin(registry: AtomRegistry.AtomRegistry, intent: OptimisticIntent<State, Receipt>) {
    const target = resource(intent.key);
    const existing = registry
      .get(target.entries)
      .find((entry) => entry.key.commandId === intent.key.commandId);
    const existingToken = existing?.token;
    const token =
      existing !== undefined && existing.status !== "rejected"
        ? existing.token
        : Symbol(intent.key.commandId);
    if (existing === undefined || existing.status === "rejected") {
      const fresh: ActiveEntry = {
        ...intent,
        key: { ...intent.key },
        token,
        status: "pending",
        acknowledgment: { status: "pending" },
      };
      registry.update(target.entries, (entries) => [
        ...entries.filter((entry) => entry.token !== existingToken),
        fresh,
      ]);
      observe(registry, target);
    }

    const update = (change: (entry: ActiveEntry) => StoredEntry) => {
      registry.update(target.entries, (entries) =>
        entries.map((entry) =>
          entry.token === token && entry.status !== "rejected" ? change(entry) : entry,
        ),
      );
    };
    return {
      acknowledge(receipt: Receipt) {
        update((entry) => ({
          ...entry,
          status: "confirming",
          acknowledgment: { status: "acknowledged", receipt },
        }));
        reconcile(registry, target, registry.get(target.source));
      },
      markUnknown() {
        update((entry) => ({ ...entry, status: "unknown" }));
      },
      reject(cause: Rejection) {
        update((entry) => ({
          key: entry.key,
          ...(entry.actionId === undefined ? {} : { actionId: entry.actionId }),
          ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
          token,
          acknowledgment: entry.acknowledgment,
          status: "rejected",
          cause,
        }));
        registry.update(target.entries, (entries) => {
          let excess =
            entries.filter((entry) => entry.status === "rejected").length - rejectedLimit;
          return entries.filter((entry) => entry.status !== "rejected" || excess-- <= 0);
        });
        stopIfIdle(registry, target);
      },
      cancel() {
        registry.update(target.entries, (entries) =>
          entries.filter((entry) => entry.token !== token),
        );
        stopIfIdle(registry, target);
      },
    };
  }

  return {
    begin,
    snapshotAtom: (scope: OptimisticScope) => snapshots(scopeKey(scope)),
    entriesAtom: (scope: OptimisticScope, status?: OptimisticStatus) =>
      selectors({ ...scopeKey(scope), status }),
    dismissRejection(registry: AtomRegistry.AtomRegistry, key: OptimisticKey) {
      registry.update(entriesFamily(scopeKey(key)), (entries) =>
        entries.filter(
          (entry) => entry.status !== "rejected" || entry.key.commandId !== key.commandId,
        ),
      );
    },
    /** Release unresolved intents and their source subscription when leaving an account or resource. */
    clear(registry: AtomRegistry.AtomRegistry, scope: OptimisticScope) {
      const target = resource(scope);
      registry.set(target.entries, []);
      stopIfIdle(registry, target);
    },
  };
}
