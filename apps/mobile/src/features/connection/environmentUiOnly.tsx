// signalbox: environment screens a deep link can still open where environments are hidden.
import {
  type NavigationProp,
  type ParamListBase,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import { type ComponentType, useEffect } from "react";

import { useShowsEnvironmentUi } from "../../state/environmentCapabilities";

/**
 * `Screen` where environments are shown; elsewhere (Signalbox Cloud, the user's one
 * environment) its route goes back to Home instead of showing environments that aren't there.
 * Several of these sit in a sheet's own stack, so this leaves the sheet from the root stack
 * rather than pushing a second Home inside it.
 */
export function environmentUiOnly<Props extends object>(Screen: ComponentType<Props>) {
  return function EnvironmentUiOnlyScreen(props: Props) {
    const showsEnvironments = useShowsEnvironmentUi();
    const navigation = useNavigation<NavigationProp<ParamListBase>>();
    useEffect(() => {
      if (showsEnvironments) return;
      let root = navigation;
      for (let parent = root.getParent(); parent; parent = parent.getParent()) root = parent;
      root.dispatch(root.canGoBack() ? StackActions.popToTop() : StackActions.replace("Home"));
    }, [navigation, showsEnvironments]);
    return showsEnvironments ? <Screen {...props} /> : null;
  };
}
