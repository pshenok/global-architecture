import { readFileSync } from 'node:fs';
import { closeHealthClients, requestIdFromHttp } from '@ga/service-kit';
import type { AbstractHttpAdapter } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import type { Config } from './config.ts';
import { setupOpenApi } from './http/openapi.ts';
import { ProblemDetailsFilter } from './http/problem-details.ts';
import { validationPipe } from './http/validation.ts';

/** Fastify adapter: HTTPS with HTTP/2 and HTTP/1.1 fallback (ALPN), request ids, body limit. */
export function createAdapter(config: Config): AbstractHttpAdapter {
  const common = {
    logger: false,
    genReqId: requestIdFromHttp,
    bodyLimit: config.BODY_LIMIT_BYTES,
    trustProxy: config.TRUST_PROXY,
    requestTimeout: 30_000,
  };
  if (!config.TLS_ENABLED) return new FastifyAdapter(common);
  let key: Buffer;
  let cert: Buffer;
  try {
    key = readFileSync(config.TLS_KEY_FILE);
    cert = readFileSync(config.TLS_CERT_FILE);
  } catch (error) {
    throw new Error(
      `TLS is enabled but ${config.TLS_CERT_FILE} / ${config.TLS_KEY_FILE} cannot be read. Run \`pnpm certs\` or set TLS_ENABLED=false behind a TLS proxy. (${String(error)})`,
    );
  }
  // HTTP/2 server types differ from the default HTTP/1 ones; Nest handles both at runtime.
  const options = { ...common, http2: true, https: { allowHTTP1: true, key, cert } };
  return new FastifyAdapter(options);
}

/** Everything that turns a Nest app into the gateway. Shared by main.ts and the tests. */
export function configureGateway(app: NestFastifyApplication, config: Config): void {
  app.useLogger(app.get(Logger));
  app.useSecurityHeaders(
    config.DOCS_ENABLED
      ? {
          // Relaxed only for the /docs UI (Scalar loads from jsDelivr). The API serves JSON only.
          contentSecurityPolicy: {
            useDefaults: true,
            directives: {
              'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
              'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
              'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
              'connect-src': ["'self'"],
            },
          },
        }
      : {},
  );
  const origins = config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length > 0)
    app.enableCors({ origin: origins, exposedHeaders: ['x-request-id', 'location'] });
  app.useGlobalPipes(validationPipe);
  app.useGlobalFilters(new ProblemDetailsFilter());
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (request, reply) => {
      void reply.header('x-request-id', request.id);
    });
  if (config.DOCS_ENABLED) setupOpenApi(app);
  app.enableShutdownHooks();
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onClose', async () => closeHealthClients());
}
