import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

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
  app.use('/docs', apiReference({ content: document, withFastify: true }));
}
