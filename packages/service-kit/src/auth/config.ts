import { z } from 'zod';

const WORKLOAD_NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/** kebab-case workload name: a service name (`booking-service`) or an edge (`gateway`). */
export const workloadName = () =>
  z.string().regex(WORKLOAD_NAME, 'must be a kebab-case workload name, e.g. booking-service');

/**
 * Workload identity of every gRPC service and of the gateway (ADR-0004).
 * `pnpm keys` creates these files locally in `.certs/`.
 */
export const workloadIdentityConfigSchema = z.object({
  /** This workload's private Ed25519 key (JWK). A secret: mount it into this workload only. */
  WORKLOAD_KEY_FILE: z.string().min(1),
  /** Public keys of every workload, `{"workloads":{"<name>":{"keys":[...]}}}`. Not secret. */
  WORKLOAD_KEYS_FILE: z.string().min(1),
  /** How often WORKLOAD_KEYS_FILE is re-read (key rotation without restarts). */
  WORKLOAD_KEYS_RELOAD_S: z.coerce.number().int().min(1).max(3_600).default(60),
  /** Edge workloads allowed to sign user principals, comma-separated. */
  PRINCIPAL_ISSUERS: z
    .string()
    .default('gateway')
    .transform((value) =>
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    )
    .pipe(z.array(workloadName()).min(1)),
});

export type WorkloadIdentityConfig = z.output<typeof workloadIdentityConfigSchema>;
