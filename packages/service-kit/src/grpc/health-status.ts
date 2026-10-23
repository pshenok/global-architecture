import { setTimeout as sleep } from 'node:timers/promises';
import { Server, ServerCredentials } from '@grpc/grpc-js';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HealthImplementation, type ServingStatus } from 'grpc-health-check';
import { CONFIG } from '../config/config.ts';
import { SERVICE_DEFINITION, type ServiceDefinition } from '../platform/service-definition.ts';

export type HealthCheck = () => Promise<unknown>;

const CHECK_INTERVAL_MS = 5_000;
const CHECK_TIMEOUT_MS = 2_000;

/**
 * Standard grpc.health.v1 status of this service (what Kubernetes gRPC probes and
 * grpc_health_probe call). NOT_SERVING until the server listens, SERVING while all
 * registered dependency checks pass, NOT_SERVING again during shutdown. Served on the
 * gRPC port and, with GRPC_HEALTH_PORT, alone in plaintext for kubelet (see serveProbes).
 */
@Injectable()
export class HealthStatus implements BeforeApplicationShutdown, OnApplicationShutdown {
  readonly implementation: HealthImplementation;
  private readonly logger = new Logger(HealthStatus.name);
  private readonly checks = new Map<string, HealthCheck>();
  private timer: NodeJS.Timeout | undefined;
  private current: ServingStatus = 'NOT_SERVING';
  private shuttingDown = false;
  private probeServer: Server | undefined;

  constructor(
    @Inject(SERVICE_DEFINITION) private readonly service: ServiceDefinition,
    @Inject(CONFIG) private readonly config: { SHUTDOWN_DELAY_MS?: number },
  ) {
    this.implementation = new HealthImplementation(
      Object.fromEntries(['', ...service.services].map((name) => [name, 'NOT_SERVING'])),
    );
  }

  /** Adds a dependency probe (e.g. `select 1`). A failing probe flips the service to NOT_SERVING. */
  registerCheck(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  /** Called once the server listens: runs the checks now and then periodically. */
  async start(): Promise<void> {
    await this.evaluate();
    this.timer = setInterval(() => void this.evaluate(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Serves grpc.health.v1 alone, in plaintext, on a second port: Kubernetes native gRPC
   * probes cannot use TLS, and the gRPC port refuses plaintext off loopback. It only
   * says SERVING or NOT_SERVING; every other RPC stays on the TLS port. Returns the port.
   */
  async serveProbes(host: string, port: number): Promise<number> {
    const server = new Server();
    this.implementation.addToServer(server);
    const bound = await new Promise<number>((resolve, reject) => {
      server.bindAsync(`${host}:${port}`, ServerCredentials.createInsecure(), (error, actual) =>
        error ? reject(error) : resolve(actual),
      );
    });
    this.probeServer = server;
    return bound;
  }

  get status(): ServingStatus {
    return this.current;
  }

  async evaluate(): Promise<ServingStatus> {
    if (this.shuttingDown) return this.current;
    const failures: string[] = [];
    await Promise.all(
      [...this.checks].map(async ([name, check]) => {
        try {
          await Promise.race([
            check(),
            sleep(CHECK_TIMEOUT_MS, undefined, { ref: false }).then(() => {
              throw new Error('timed out');
            }),
          ]);
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    const next: ServingStatus = failures.length === 0 ? 'SERVING' : 'NOT_SERVING';
    if (next !== this.current) {
      if (next === 'SERVING') this.logger.log('health: SERVING');
      else this.logger.warn(`health: NOT_SERVING (${failures.join('; ')})`);
    }
    this.set(next);
    return next;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.timer);
    this.set('NOT_SERVING');
    const delay = this.config.SHUTDOWN_DELAY_MS ?? 0;
    if (delay > 0) await sleep(delay);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.probeServer?.forceShutdown();
    this.probeServer = undefined;
  }

  private set(next: ServingStatus): void {
    this.current = next;
    for (const name of ['', ...this.service.services]) this.implementation.setStatus(name, next);
  }
}
