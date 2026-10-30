import { createFileRoute } from "@tanstack/react-router";
import { DesktopCapturePanel } from "../components/capture/DesktopCapturePanel";

export const Route = createFileRoute("/capture")({ component: DesktopCapturePanel });
