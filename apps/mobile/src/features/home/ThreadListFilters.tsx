import { Pressable, ScrollView } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { useShowsEnvironmentUi } from "../../state/environmentCapabilities"; // signalbox
import { useFolderCopy } from "../folders/use-folder-copy"; // signalbox: folders

export function ThreadListFilters(
  props: Pick<
    HomeHeaderProps,
    | "environments"
    | "projects"
    | "selectedEnvironmentId"
    | "selectedProjectKey"
    | "onEnvironmentChange"
    | "onProjectChange"
  >,
) {
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  const showsEnvironments = useShowsEnvironmentUi(); // signalbox
  const folderCopy = useFolderCopy(); // signalbox: folders
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      {showsEnvironments ? (
        <ListFilterMenu
          label={selectedEnvironment?.label ?? "All environments"}
          accessibilityLabel="Filter threads by environment"
          active={selectedEnvironment !== undefined}
          actions={[
            {
              id: "all",
              title: "All environments",
              state: props.selectedEnvironmentId === null ? "on" : "off",
            },
            ...props.environments.map((environment) => ({
              id: JSON.stringify(environment.environmentId),
              title: environment.label,
              state:
                environment.environmentId === props.selectedEnvironmentId
                  ? ("on" as const)
                  : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") props.onEnvironmentChange(null);
            else {
              const environment = props.environments.find(
                (candidate) => JSON.stringify(candidate.environmentId) === id,
              );
              if (environment) props.onEnvironmentChange(environment.environmentId);
            }
          }}
        />
      ) : null}
      <ListFilterMenu
        label={selectedProject?.label ?? folderCopy("All projects")}
        accessibilityLabel={folderCopy("Filter threads by project")}
        active={selectedProject !== undefined}
        actions={[
          {
            id: "all",
            title: folderCopy("All projects"),
            state: props.selectedProjectKey === null ? "on" : "off",
          },
          ...props.projects.map((project) => ({
            id: JSON.stringify(project.key),
            title: project.label,
            state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onProjectChange(null);
          else {
            const project = props.projects.find(
              (candidate) => JSON.stringify(candidate.key) === id,
            );
            if (project) props.onProjectChange(project.key);
          }
        }}
      />
      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onEnvironmentChange(null);
            props.onProjectChange(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
