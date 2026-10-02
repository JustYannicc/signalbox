import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

// Filled outlines of the web mark (apps/web/src/components/SignalboxMark.tsx)
// on the same 24pt grid: the box, and the arm raised from its lower-left pivot.
const BOX =
  "M8.5 1.875H15.5A6.625 6.625 0 0 1 22.125 8.5V15.5A6.625 6.625 0 0 1 15.5 22.125H8.5A6.625 6.625 0 0 1 1.875 15.5V8.5A6.625 6.625 0 0 1 8.5 1.875ZM8.5 4.125H15.5A4.375 4.375 0 0 1 19.875 8.5V15.5A4.375 4.375 0 0 1 15.5 19.875H8.5A4.375 4.375 0 0 1 4.125 15.5V8.5A4.375 4.375 0 0 1 8.5 4.125Z";
const ARM =
  "M8.987 17.487L16.237 10.237A1.75 1.75 0 0 0 13.763 7.763L6.513 15.013A1.75 1.75 0 0 0 8.987 17.487Z";

/** The Signalbox mark, square, sized by `height`. */
export function SignalboxMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Signalbox"
      height={props.height}
      width={props.height}
      viewBox="1.875 1.875 20.25 20.25"
    >
      <ThemedPath
        d={BOX}
        fillRule="evenodd"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <ThemedPath
        d={ARM}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
