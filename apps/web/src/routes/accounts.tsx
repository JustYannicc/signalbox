import { createFileRoute } from "@tanstack/react-router";

import { AccountPoolsPage } from "../components/accounts/AccountPoolsPage";

export const Route = createFileRoute("/accounts")({
  component: AccountPoolsPage,
});
