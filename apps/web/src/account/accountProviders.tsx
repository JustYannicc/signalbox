import type { AccountProvider } from "@t3tools/contracts/account";
import type { SVGProps } from "react";

import { AppleIcon, GitHubIcon, GoogleIcon, type Icon } from "../components/Icons";

const MonochromeGitHubIcon: Icon = (props: SVGProps<SVGSVGElement>) => (
  <GitHubIcon aria-hidden="true" {...props} />
);

/**
 * Display data per sign-in option. The server's `providers` list decides what
 * shows; adding a provider is one entry here.
 */
export const ACCOUNT_PROVIDER_PRESENTATION: Readonly<
  Record<AccountProvider, { readonly label: string; readonly Icon: Icon | null }>
> = {
  google: { label: "Google", Icon: GoogleIcon },
  github: { label: "GitHub", Icon: MonochromeGitHubIcon },
  apple: { label: "Apple", Icon: AppleIcon },
  email: { label: "email", Icon: null },
};
