/**
 * signalbox: thread-list menus file their environment filter under this id. A user with one
 * environment (Signalbox Cloud) gets the menu without it.
 */
export const ENVIRONMENT_FILTER_ID = "environment";

export function withoutEnvironmentFilter<T extends { readonly id?: string }>(
  items: ReadonlyArray<T>,
  showsEnvironments: boolean,
): Array<T> {
  return showsEnvironments ? [...items] : items.filter((item) => item.id !== ENVIRONMENT_FILTER_ID);
}

/** For `useHomeListOptions` while environments are hidden: no environment can be selected. */
export const NO_ENVIRONMENTS: ReadonlySet<never> = new Set();

/** A saved environment selection only applies while the user can see and clear it. */
export function visibleEnvironmentSelection<T>(selection: T | null, showsEnvironments: boolean) {
  return showsEnvironments ? selection : null;
}
