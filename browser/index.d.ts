export interface InitClerkAuthOptions {
  el?: HTMLElement | null;
  configUrl?: string;
  syncUrl?: string;
  appearance?: Record<string, unknown>;
  redirectUrl?: string;
  onSignedIn?: (result: Record<string, unknown>) => void;
  onUnavailable?: (reason: "no-key" | "load-failed") => void;
  onError?: (error: Error) => void;
}

export interface ClerkAuthController {
  clerk: unknown | null;
  unmount: () => void;
}

export const chromelessElements: Record<string, Record<string, string>>;
export function initClerkAuth(opts?: InitClerkAuthOptions): Promise<ClerkAuthController>;
export function clerkSignOut(opts?: { configUrl?: string }): Promise<void>;
