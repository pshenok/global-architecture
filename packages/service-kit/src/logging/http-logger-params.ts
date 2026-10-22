import type { Params } from 'nestjs-pino';
import { REDACT_PATHS } from './logger-params.ts';

export interface HttpLoggerConfig {
  readonly LOG_LEVEL: string;
  readonly LOG_PRETTY: boolean;
}

/**
 * nestjs-pino params for an HTTP app (gateway/BFF). Fastify assigns request.id
 * (see `requestIdFromHttp`), pino-http reuses it as `requestId` on every line.
 * Health probes are not logged.
 */
export function httpLoggerParams(serviceName: string, config: HttpLoggerConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      base: { service: serviceName },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      customAttributeKeys: { reqId: 'requestId' },
      quietReqLogger: true,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      ...(config.LOG_PRETTY
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
    },
  };
}
