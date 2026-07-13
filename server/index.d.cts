import type { Express, Router, Request, Response, NextFunction, RequestHandler } from "express";
import type { Pool } from "pg";

export interface NormalizedIdentity {
  externalId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  provider: string;
}

export interface FindOrCreateResult {
  userId: string | number;
  [extra: string]: unknown;
}

export interface DevBypassOptions {
  enabled: boolean;
  user?: Partial<NormalizedIdentity>;
}

export interface CreateClerkAuthOptions {
  publishableKey?: string | null;
  secretKey?: string | null;
  basePath?: string;
  findOrCreateUser: (identity: NormalizedIdentity) => Promise<FindOrCreateResult> | FindOrCreateResult;
  onSession?: (req: Request, result: FindOrCreateResult) => void | Promise<void>;
  devBypass?: DevBypassOptions | null;
}

export interface ClerkAuth {
  router: Router;
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  enabled: boolean;
  devBypass: boolean;
}

export function createClerkAuth(opts: CreateClerkAuthOptions): ClerkAuth;

export interface InstallSessionsOptions {
  name: string;
  secret?: string | null;
  pool?: Pool | null;
  schemaName?: string;
  tableName?: string;
  cookie?: Record<string, unknown>;
  insecureSecrets?: string[];
}

export function installSessions(app: Express, opts: InstallSessionsOptions): RequestHandler;

export function verifyAndNormalize(args: {
  token: string;
  secretKey: string;
  clerkClient: unknown;
}): Promise<NormalizedIdentity>;
