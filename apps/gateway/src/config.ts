import { grpcTarget, workloadIdentityConfigSchema } from '@ga/service-kit';
import { z } from 'zod';

/** Environment of the gateway, validated at boot. */
const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  /** Bind address. 127.0.0.1 locally; 0.0.0.0 in containers. */
  GATEWAY_HOST: z.string().min(1).default('127.0.0.1'),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8443),
  /** Serve HTTPS (HTTP/2 + HTTP/1.1). Disable only behind a TLS-terminating proxy. */
  TLS_ENABLED: z.stringbool().default(true),
  TLS_CERT_FILE: z.string().default('../../.certs/dev-cert.pem'),
  TLS_KEY_FILE: z.string().default('../../.certs/dev-key.pem'),
  /** Comma-separated browser origins allowed by CORS; empty = no cross-origin access. */
  CORS_ORIGINS: z.string().default(''),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Trust X-Forwarded-* (only behind a known proxy). */
  TRUST_PROXY: z.stringbool().default(false),
  /** Serve /docs (Scalar) and /openapi.json. Default: on, except when NODE_ENV=production. */
  DOCS_ENABLED: z.stringbool().optional(),
  /** CA bundle of the services' gRPC certificates; required when they are not on loopback. */
  GRPC_TLS_CA_FILE: z.string().min(1).optional(),
  USER_SERVICE_URL: grpcTarget(),
  HOUSE_SERVICE_URL: grpcTarget(),
  BOOKING_SERVICE_URL: grpcTarget(),
  ...workloadIdentityConfigSchema.shape,
});

export const ConfigSchema = BaseConfigSchema.transform((config) => ({
  ...config,
  DOCS_ENABLED: config.DOCS_ENABLED ?? config.NODE_ENV !== 'production',
}));

export type Config = z.output<typeof ConfigSchema>;
