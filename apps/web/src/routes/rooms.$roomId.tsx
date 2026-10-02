import { createFileRoute } from "@tanstack/react-router";

import { RoomPage } from "../components/rooms/RoomPage";

/** `?container=section:…|team-project:…|root`: where a new room lands. */
function validateRoomSearch(raw: Record<string, unknown>): { container?: string } {
  return typeof raw.container === "string" && raw.container.length > 0
    ? { container: raw.container }
    : {};
}

function RoomRoute() {
  const { roomId } = Route.useParams();
  const { container } = Route.useSearch();
  return <RoomPage key={roomId} roomId={roomId} containerKey={container ?? null} />;
}

export const Route = createFileRoute("/rooms/$roomId")({
  validateSearch: validateRoomSearch,
  component: RoomRoute,
});
