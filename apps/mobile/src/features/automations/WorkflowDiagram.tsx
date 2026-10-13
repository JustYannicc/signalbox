import {
  roundedPath,
  type DiagramRun,
  type EdgeRunState,
} from "@t3tools/client-runtime/automations/diagram";
import { CONTAINER_TYPE_LABEL, stepTypeLabel } from "@t3tools/client-runtime/automations/labels";
import type {
  LayoutCard,
  LayoutContainer,
  LayoutEdge,
  WorkflowLayout,
} from "@t3tools/client-runtime/automations/layout";
import type { NodeRunState } from "@t3tools/client-runtime/automations/runState";
import {
  DISPLAY_STATUS_LABEL,
  stepDisplayStatus,
  type AutomationDisplayStatus,
} from "@t3tools/client-runtime/automations/status";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { withUniwind } from "uniwind";

import { SymbolView, type AppSymbolViewProps } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { StatusDot } from "./AutomationParts";
import { ServiceLogo } from "./ServiceLogo";

/**
 * The automation drawn from its layout, with one run over it: what never ran
 * fades and edges show the path taken. Lines are small per-edge SVGs rather
 * than one canvas-sized SVG, whose backing bitmap would grow with the whole
 * automation; cards are ordinary views so they stay tappable and readable.
 */
export const WorkflowDiagram = memo(function WorkflowDiagram(props: {
  readonly layout: WorkflowLayout;
  readonly run: DiagramRun;
  readonly onPressStep: (nodeId: string) => void;
}) {
  const { layout, run } = props;
  return (
    <View style={{ width: layout.width, height: layout.height }} collapsable={false}>
      {layout.containers.map((container) => (
        <ContainerBox
          key={container.id}
          container={container}
          faded={!run.reached.has(container.id)}
        />
      ))}
      {layout.edges.map((edge) => (
        <EdgeLine key={edge.id} edge={edge} state={run.edges.get(edge.id) ?? "plain"} />
      ))}
      {layout.edges.map((edge) =>
        edge.label && edge.labelAt ? (
          <EdgeLabel
            key={edge.id}
            label={edge.label}
            at={edge.labelAt}
            state={run.edges.get(edge.id) ?? "plain"}
          />
        ) : null,
      )}
      {layout.cards.map((card) => (
        <Card
          key={card.id}
          card={card}
          faded={card.kind !== "trigger" && !run.reached.has(card.id)}
          state={run.states.get(card.id) ?? null}
          onPressStep={props.onPressStep}
        />
      ))}
    </View>
  );
});

const CONTAINER_SYMBOL: Record<LayoutContainer["kind"], AppSymbolViewProps["name"]> = {
  each: "arrow.clockwise",
  repeat: "arrow.clockwise",
  for: "arrow.clockwise",
  while: "arrow.clockwise",
  parallel: "square.split.2x1",
  try: "exclamationmark.triangle",
};

function ContainerBox(props: { readonly container: LayoutContainer; readonly faded: boolean }) {
  const { container } = props;
  return (
    <View
      pointerEvents="none"
      className={cn(
        "absolute rounded-[20px] border border-border bg-adaptive-black-a2p5-white-a2p5",
        props.faded && "opacity-50",
      )}
      style={{
        left: container.x,
        top: container.y,
        width: container.width,
        height: container.height,
      }}
    >
      <View className="h-[34px] flex-row items-center gap-1.5 px-3.5">
        <SymbolView
          name={CONTAINER_SYMBOL[container.kind]}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="shrink text-xs font-t3-medium text-foreground" numberOfLines={1}>
          {container.label.trim() || CONTAINER_TYPE_LABEL[container.kind]}
        </Text>
        {container.detail ? (
          <Text className="shrink-0 text-xs text-foreground-muted" numberOfLines={1}>
            · {container.detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const ARROW = 5;

const ThemedPath = withUniwind(Path);

const EDGE_COLOR: Record<EdgeRunState, string> = {
  taken: "accent-foreground",
  untaken: "accent-border",
  plain: "accent-foreground-muted",
};

const EdgeLine = memo(function EdgeLine(props: {
  readonly edge: LayoutEdge;
  readonly state: EdgeRunState;
}) {
  const { edge, state } = props;
  // Edges that land on a card or box get an arrowhead; joins meet mid-air and don't.
  const arrow = edge.to !== null;
  const xs = edge.points.map((point) => point.x);
  const ys = edge.points.map((point) => point.y);
  const pad = ARROW + 2;
  const left = Math.min(...xs) - pad;
  const top = Math.min(...ys) - pad;
  const width = Math.max(...xs) - left + pad;
  const height = Math.max(...ys) - top + pad;
  const local = edge.points.map((point) => ({ x: point.x - left, y: point.y - top }));
  const end = local[local.length - 1];
  // Stop the line short of the arrowhead so the tip stays sharp.
  const line = arrow && end ? [...local.slice(0, -1), { x: end.x, y: end.y - ARROW }] : local;
  const colorClassName = EDGE_COLOR[state];
  const opacity = state === "plain" ? 0.55 : state === "taken" ? 0.75 : 1;

  return (
    <Svg
      pointerEvents="none"
      width={width}
      height={height}
      style={{ position: "absolute", left, top }}
    >
      <ThemedPath
        d={roundedPath(line, 8)}
        colorClassName={colorClassName}
        stroke="currentColor"
        strokeOpacity={opacity}
        strokeWidth={state === "taken" ? 2 : 1.5}
        strokeDasharray={edge.failure ? "5 4" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {arrow && end ? (
        <ThemedPath
          d={`M${end.x - ARROW} ${end.y - ARROW - 1} L${end.x + ARROW} ${end.y - ARROW - 1} L${end.x} ${end.y} Z`}
          colorClassName={colorClassName}
          fill="currentColor"
          fillOpacity={opacity}
        />
      ) : null}
    </Svg>
  );
});

const LABEL_SLOT = 180;

function EdgeLabel(props: {
  readonly label: string;
  readonly at: { readonly x: number; readonly y: number };
  readonly state: EdgeRunState;
}) {
  const { at, state } = props;
  return (
    <View
      pointerEvents="none"
      className="absolute items-center justify-center"
      style={{ left: at.x - LABEL_SLOT / 2, top: at.y - 11, width: LABEL_SLOT, height: 22 }}
    >
      <View
        className={cn(
          "max-w-full rounded-full border border-border bg-screen px-2.5 py-0.5",
          state === "untaken" && "opacity-50",
        )}
      >
        <Text
          className={cn(
            "text-xs font-t3-medium",
            state === "taken" ? "text-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {props.label}
        </Text>
      </View>
    </View>
  );
}

const CARD_BORDER: Record<AutomationDisplayStatus, string> = {
  needsYou: "border-warning-border bg-warning",
  working: "border-adaptive-sky-600-400 bg-card",
  waiting: "border-adaptive-sky-600-400 bg-card",
  failed: "border-danger-border bg-card",
  done: "border-border bg-card",
  cancelled: "border-border bg-card",
};

const Card = memo(function Card(props: {
  readonly card: LayoutCard;
  readonly faded: boolean;
  readonly state: NodeRunState | null;
  readonly onPressStep: (nodeId: string) => void;
}) {
  const { card, faded, state } = props;
  const frame = { left: card.x, top: card.y, width: card.width, height: card.height };

  if (card.kind === "trigger") {
    return (
      <View
        className="absolute flex-row items-center justify-center gap-2 rounded-full bg-update px-4"
        style={frame}
      >
        <SymbolView name="bolt.circle" size={16} tintColorClassName="accent-update-foreground" />
        <Text className="shrink text-sm font-t3-bold text-update-foreground" numberOfLines={1}>
          {card.label}
        </Text>
      </View>
    );
  }

  if (card.kind === "end") {
    return (
      <View
        className={cn(
          "absolute items-center justify-center rounded-full border border-border bg-grouped-card",
          faded && "opacity-40",
        )}
        style={frame}
      >
        <Text className="text-xs font-t3-medium text-foreground-muted">
          {card.done ? "Done" : "End"}
        </Text>
      </View>
    );
  }

  if (card.kind === "decision") {
    return (
      <View
        accessible
        accessibilityLabel={`Decision: ${card.node.label.text}`}
        className={cn(
          "absolute flex-row items-center gap-2.5 rounded-full border border-border bg-card px-4",
          faded && "opacity-40",
        )}
        style={frame}
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={15}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground" numberOfLines={2}>
          {card.node.label.text}
        </Text>
      </View>
    );
  }

  const { node } = card;
  const status = state ? stepDisplayStatus({ status: state.status, verb: node.verb }) : null;
  const subtitle = stepTypeLabel(node);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${node.label.text}, ${subtitle}${status ? `, ${DISPLAY_STATUS_LABEL[status]}` : ""}`}
      onPress={() => props.onPressStep(card.id)}
      className={cn(
        "absolute flex-row items-center gap-2.5 rounded-[14px] border px-3 active:opacity-70",
        status ? CARD_BORDER[status] : "border-border bg-card",
        faded && "opacity-40",
      )}
      style={frame}
    >
      <ServiceLogo verb={node.verb} service={node.service} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {node.label.text}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {state && status ? (
        <View className="flex-row items-center gap-1">
          {state.runs > 1 ? (
            <Text className="text-xs font-t3-medium text-foreground-muted">×{state.runs}</Text>
          ) : null}
          <StatusGlyph status={status} />
        </View>
      ) : null}
    </Pressable>
  );
});

function StatusGlyph({ status }: { readonly status: AutomationDisplayStatus }) {
  if (status === "done") {
    return (
      <SymbolView
        name="checkmark.circle"
        size={16}
        tintColorClassName="accent-adaptive-emerald-600-400"
      />
    );
  }
  if (status === "failed") {
    return (
      <SymbolView
        name="exclamationmark.circle"
        size={16}
        tintColorClassName="accent-adaptive-rose-600-400"
      />
    );
  }
  return <StatusDot status={status} size="md" />;
}
