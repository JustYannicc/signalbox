import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

type IntlWithTimezoneValues = typeof Intl & {
  readonly supportedValuesOf?: (key: "timeZone") => ReadonlyArray<string>;
};

export function detectDeviceTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return null;
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}

export function supportedTimezones(deviceTimezone = detectDeviceTimezone()): ReadonlyArray<string> {
  let zones: ReadonlyArray<string> = [];
  try {
    zones = (Intl as IntlWithTimezoneValues).supportedValuesOf?.call(Intl, "timeZone") ?? [];
  } catch {
    // Keep the current device and UTC selectable on runtimes without supportedValuesOf.
  }
  return Array.from(new Set(["UTC", ...zones, ...(deviceTimezone ? [deviceTimezone] : [])])).sort(
    (left, right) => left.localeCompare(right),
  );
}

export function supportsPersonTimezone(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "personTimezone"> | null | undefined,
): boolean {
  return capabilities?.personTimezone === true;
}

interface PersonTimezoneEnvironmentCandidate<Id extends string> {
  readonly environmentId: Id;
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: ExecutionEnvironmentCapabilities;
    };
  } | null;
}

export function connectedPersonTimezoneEnvironmentIds<Id extends string>(
  environments: ReadonlyArray<PersonTimezoneEnvironmentCandidate<Id>>,
): ReadonlyArray<Id> {
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        supportsPersonTimezone(environment.serverConfig?.environment.capabilities),
    )
    .map((environment) => environment.environmentId)
    .sort();
}

export function createPersonTimezoneReportPermissionsAtom(
  environmentIds: ReadonlyArray<EnvironmentId>,
  permissionAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>,
): Atom.Atom<ReadonlyArray<boolean>> {
  return Atom.make((get) =>
    environmentIds.map((environmentId) => get(permissionAtom(environmentId))),
  );
}

export function permittedPersonTimezoneEnvironmentIds<Id extends string>(
  environmentIds: ReadonlyArray<Id>,
  permissions: ReadonlyArray<boolean>,
): ReadonlyArray<Id> {
  return environmentIds.filter((_, index) => permissions[index] === true);
}

export class DeviceTimezoneReportCache<EnvironmentId extends string> {
  private readonly reported = new Map<EnvironmentId, string>();

  shouldReport(environmentId: EnvironmentId, timezone: string, force = false): boolean {
    if (!force && this.reported.get(environmentId) === timezone) return false;
    this.reported.set(environmentId, timezone);
    return true;
  }

  failed(environmentId: EnvironmentId): void {
    this.reported.delete(environmentId);
  }

  forget(environmentId: EnvironmentId): void {
    this.reported.delete(environmentId);
  }
}

export class PersonTimezoneReportCoordinator<EnvironmentId extends string> {
  private readonly active = new Set<EnvironmentId>();
  private readonly cache = new DeviceTimezoneReportCache<EnvironmentId>();

  setActiveEnvironmentIds(
    environmentIds: ReadonlyArray<EnvironmentId>,
    report: (environmentId: EnvironmentId, timezone: string) => Promise<boolean>,
  ): void {
    const next = new Set(environmentIds);
    for (const environmentId of this.active) {
      if (!next.has(environmentId)) this.cache.forget(environmentId);
    }
    for (const environmentId of next) {
      if (!this.active.has(environmentId)) this.send(environmentId, report, true);
    }
    this.active.clear();
    for (const environmentId of next) this.active.add(environmentId);
  }

  reportOnForeground(
    report: (environmentId: EnvironmentId, timezone: string) => Promise<boolean>,
  ): void {
    for (const environmentId of this.active) this.send(environmentId, report, true);
  }

  private send(
    environmentId: EnvironmentId,
    report: (environmentId: EnvironmentId, timezone: string) => Promise<boolean>,
    force: boolean,
  ): void {
    const timezone = detectDeviceTimezone();
    if (!timezone || !this.cache.shouldReport(environmentId, timezone, force)) return;
    try {
      void report(environmentId, timezone).then(
        (succeeded) => {
          if (!succeeded) this.cache.failed(environmentId);
        },
        () => this.cache.failed(environmentId),
      );
    } catch {
      this.cache.failed(environmentId);
    }
  }
}
