// signalbox: the navigation panel shows folders for environments that keep them.
import type { EnvironmentId } from "@t3tools/contracts";
import type { ComponentType } from "react";

import { useServerConfigs } from "../../state/entities";
import { useEnvironmentHasFolders } from "../../state/signalboxFolders";
import { FolderNavigationEnvironment } from "./FolderNavigationEnvironment";
import { navigationPanelCopy } from "./panel-copy";

interface EnvironmentTreeProps {
  readonly environment: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly environmentCount: number;
  readonly selectedProjectKey: string | null;
  readonly onProjectChange: (key: string | null) => void;
}

/** One environment's tree: its folders where it keeps them, else `Sections`. */
export function withFolderTrees<Props extends EnvironmentTreeProps>(
  Sections: ComponentType<Props>,
) {
  return function EnvironmentTree(props: Props) {
    const hasFolders = useEnvironmentHasFolders(props.environment.environmentId);
    if (!hasFolders) return <Sections {...props} />;
    return (
      <FolderNavigationEnvironment
        environmentId={props.environment.environmentId}
        label={props.environmentCount > 1 ? props.environment.label : null}
        selectedKey={props.selectedProjectKey}
        onSelect={props.onProjectChange}
      />
    );
  };
}

/** The panel's title, hint and hide label for the environments it lists. */
export function useNavigationPanelCopy(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
) {
  const configs = useServerConfigs();
  return navigationPanelCopy({
    withFolders: environments.filter(
      (environment) =>
        configs.get(environment.environmentId)?.environment.capabilities.folders === true,
    ).length,
    total: environments.length,
  });
}
