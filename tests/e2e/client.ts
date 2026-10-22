import { readFileSync } from 'node:fs';
import { Agent, request } from 'undici';

const ROOT = new URL('../../', import.meta.url);
export const BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
export const CA = readFileSync(new URL('.certs/dev-cert.pem', ROOT));

/** HTTPS client that trusts the local dev certificate and negotiates HTTP/2 when offered. */
const dispatcher = new Agent({ connect: { ca: CA }, allowH2: true });

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
}

export async function api<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await request(`${BASE_URL}${path}`, {
    method,
    dispatcher,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.body.text();
  return {
    status: response.statusCode,
    headers: response.headers,
    body: (text ? JSON.parse(text) : undefined) as T,
  };
}

/** GET returning the raw body (for HTML pages). */
export async function raw(
  path: string,
): Promise<{ status: number; contentType: string; text: string }> {
  const response = await request(`${BASE_URL}${path}`, { dispatcher });
  return {
    status: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    text: await response.body.text(),
  };
}

/** "YYYY-MM-DD" n days from today (UTC). */
export function day(n: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + n * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
}

export const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
