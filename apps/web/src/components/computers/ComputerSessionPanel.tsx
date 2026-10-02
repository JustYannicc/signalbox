/**
 * A visible computer session: the live desktop the agent is driving, who
 * acquired it, what it costs, and the controls to take over, pause, or
 * release it. Reusable wherever a task or chat needs to show its computer.
 * Placeholder state only; actions change local state and toast.
 */
import {
  HandIcon,
  MaximizeIcon,
  MousePointer2Icon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import { ComputerLiveView } from "./ComputerLiveView";
import { ComputerSessionDetails } from "./ComputerSessionDetails";
import {
  ComputerOsBadge,
  ComputerProvenance,
  ComputerStateBadge,
  notifyComputerPrototype,
} from "./computerPrimitives";
import { formatUsd, totalCost, type Computer, type ComputerState } from "./computerModel";

function CostSummary({ computer }: { computer: Computer }) {
  const computeNote =
    computer.state === "live" ? `${formatUsd(computer.computeRateUsdPerHour)}/h` : "stopped";
  const storageNote =
    computer.retainedGb > 0 ? `${computer.retainedGb} GB disk` : "no disk retained";
  return (
    <div className="flex flex-col items-end gap-0.5 text-right">
      <span className="text-lg font-semibold text-foreground tabular-nums">
        {formatUsd(totalCost(computer))}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        Compute {formatUsd(computer.computeUsd)} ({computeNote}) · Storage{" "}
        {formatUsd(computer.storageUsd)} ({storageNote})
      </span>
    </div>
  );
}

function SessionControls({
  state,
  controlledByUser,
  onToggleControl,
  onTogglePause,
  onRelease,
  onFullScreen,
}: {
  state: ComputerState;
  controlledByUser: boolean;
  onToggleControl: () => void;
  onTogglePause: () => void;
  onRelease: () => void;
  onFullScreen: () => void;
}) {
  const released = state === "released";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={controlledByUser ? "default" : "outline"}
        disabled={state !== "live"}
        onClick={onToggleControl}
      >
        {controlledByUser ? <MousePointer2Icon /> : <HandIcon />}
        {controlledByUser ? "Hand back" : "Take over"}
      </Button>
      <Button size="sm" variant="outline" disabled={released} onClick={onTogglePause}>
        {state === "paused" ? <PlayIcon /> : <PauseIcon />}
        {state === "paused" ? "Resume" : "Pause"}
      </Button>
      <Button size="sm" variant="destructive-outline" disabled={released} onClick={onRelease}>
        <PowerIcon />
        Release
      </Button>
      <div className="ms-auto">
        <Button size="sm" variant="ghost" disabled={released} onClick={onFullScreen}>
          <MaximizeIcon />
          Open full screen
        </Button>
      </div>
    </div>
  );
}

export function ComputerSessionPanel({ computer: initial }: { readonly computer: Computer }) {
  const [state, setState] = useState(initial.state);
  const [controlledByUser, setControlledByUser] = useState(false);
  const liveViewRef = useRef<HTMLDivElement>(null);
  const computer: Computer = { ...initial, state };

  const toggleControl = () => {
    setControlledByUser((current) => !current);
    notifyComputerPrototype(
      controlledByUser ? "Handed back to the agent" : "You have control",
      controlledByUser
        ? "The agent resumes from what's on screen."
        : "The agent waits until you hand it back.",
    );
  };
  const togglePause = () => {
    const next = state === "paused" ? "live" : "paused";
    setState(next);
    setControlledByUser(false);
    notifyComputerPrototype(
      next === "paused" ? "Computer paused" : "Computer resumed",
      next === "paused"
        ? "Compute billing stopped. The disk is kept."
        : "Compute billing restarted from the kept disk.",
    );
  };
  const release = async () => {
    // Fail closed: no mounted confirm host means no release.
    const confirmed = await requestConfirmDialog(
      `Release ${initial.name}?\nThe computer shuts down and its disk is deleted. ${initial.artifacts.length} artifacts stay in the durable workspace.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setState("released");
    setControlledByUser(false);
    notifyComputerPrototype(
      "Computer released",
      `${initial.artifacts.length} artifacts stay in the durable workspace.`,
    );
  };
  const openFullScreen = () => {
    void liveViewRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">{computer.name}</h1>
            <ComputerStateBadge state={state} />
            <ComputerOsBadge os={computer.os} version={computer.osVersion} />
          </div>
          <p className="text-xs text-muted-foreground">
            {computer.provider} · {computer.region} · {computer.size}
          </p>
          <ComputerProvenance computer={computer} />
        </div>
        <CostSummary computer={computer} />
      </header>
      <SessionControls
        state={state}
        controlledByUser={controlledByUser}
        onToggleControl={toggleControl}
        onTogglePause={togglePause}
        onRelease={() => void release()}
        onFullScreen={openFullScreen}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <ComputerLiveView
          ref={liveViewRef}
          computer={computer}
          controlledByUser={controlledByUser}
        />
        <ComputerSessionDetails computer={computer} />
      </div>
    </div>
  );
}
