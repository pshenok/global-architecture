import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

/**
 * CSP for the /docs page only: Scalar loads its bundle from jsDelivr and boots with an
 * inline script. Every other response keeps the strict default policy.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** OpenAPI 3 document generated from the controllers' Zod schemas, served at /openapi.json and /docs. */
export function setupOpenApi(app: NestFastifyApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Global Architecture API')
      .setDescription(
        'Public REST API. Every error is RFC 9457 application/problem+json with a stable `code`. ' +
          'Send x-request-id to correlate logs across services.',
      )
      .setVersion('1.0.0')
      .build(),
  );
  app
    .getHttpAdapter()
    .getInstance()
    .get('/openapi.json', (_request, reply) => {
      void reply.send(document);
    });
  // The docs handler writes to the raw response, so Fastify onSend hooks do not run for it:
  // set the page's own CSP in a middleware mounted just before it.
  app.use(
    '/docs',
    (
      _request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      response.setHeader('content-security-policy', DOCS_CSP);
      next();
    },
  );
  app.use('/docs', apiReference({ content: document, withFastify: true }));
}
