import type { Request, Router } from "express";
import type { Pool, PoolClient, QueryResult } from "pg";

export interface PairingAccount {
  userId: string | number;
  label: string;
  [extra: string]: unknown;
}
export interface DevicePairingStore {
  migrate(): Promise<void>;
  limit(key: string, maximum: number, seconds: number): Promise<void>;
  transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export function createPgDevicePairingStore(pool: Pool): DevicePairingStore;
export function createDevicePairing(options: {
  store: DevicePairingStore;
  secret: string;
  getAccount(req: Request): PairingAccount | null | Promise<PairingAccount | null>;
  resolveAccount(userId: string, client: PoolClient): PairingAccount | null | Promise<PairingAccount | null>;
  onSession(req: Request, account: PairingAccount, client: PoolClient): void | Promise<void>;
  basePath?: string;
  origin?: string | null;
}): { router: Router };
