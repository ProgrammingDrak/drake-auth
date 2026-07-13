import type { NextMiddleware } from "next/server";

export function getAllowedEmails(envVar?: string): string[];
export function isAllowedEmail(email: string | null | undefined, envVar?: string): boolean;
export function getAdminEmail(envVar?: string): Promise<string | null>;

export interface CreateAdminClerkMiddlewareOptions {
  loginRoute?: string;
  protectedRoute?: string;
  loginPath?: string;
}

export function createAdminClerkMiddleware(
  opts?: CreateAdminClerkMiddlewareOptions
): NextMiddleware;
