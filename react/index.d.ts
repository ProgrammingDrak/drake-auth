import * as React from "react";

export {
  clerkSignOut,
  chromelessElements,
  initClerkAuth,
  InitClerkAuthOptions,
  ClerkAuthController,
} from "../browser/index";

export interface ClerkSignInProps {
  appearance?: Record<string, unknown>;
  providerOnly?: boolean;
  onSignedIn?: (result: Record<string, unknown>) => void;
  onUnavailable?: (reason: "no-key" | "load-failed") => void;
  onError?: (error: Error) => void;
  redirectUrl?: string;
  configUrl?: string;
  syncUrl?: string;
  className?: string;
}

export function ClerkSignIn(props: ClerkSignInProps): React.ReactElement;

export function useAuthConfig(configUrl?: string): {
  loading: boolean;
  clerkPublishableKey: string | null;
};
