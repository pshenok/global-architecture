/**
 * OpenTelemetry bootstrap. Load it BEFORE the app:
 *
 *   node --import @ga/service-kit/telemetry dist/main.js
 *
 * It is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT (or ..._TRACES_ENDPOINT) is
 * set, so it costs nothing by default. Traces cover inbound/outbound gRPC and
 * HTTP, pg queries and Fastify routes (when the app has @fastify/otel), and pino
 * lines get trace_id/span_id. Service name comes from OTEL_SERVICE_NAME.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

if (endpoint && process.env.OTEL_SDK_DISABLED !== 'true') {
  // Synchronous in-thread ESM hooks (module.registerHooks): must run before the app graph loads.
  const { register } = await import('import-in-the-middle/register-hooks.mjs');
  register();

  const [
    { NodeSDK },
    { HttpInstrumentation },
    { GrpcInstrumentation },
    { PgInstrumentation },
    { PinoInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-grpc'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-pino'),
  ]);

  const instrumentations: unknown[] = [
    new HttpInstrumentation(),
    new GrpcInstrumentation(),
    new PgInstrumentation(),
    new PinoInstrumentation(),
  ];

  // Fastify route spans, only when the app itself depends on @fastify/otel (the gateway).
  try {
    const appRequire = createRequire(join(process.cwd(), 'package.json'));
    const fastifyOtel = (await import(pathToFileURL(appRequire.resolve('@fastify/otel')).href)) as {
      FastifyOtelInstrumentation: new (options: { registerOnInitialization: boolean }) => unknown;
    };
    instrumentations.push(
      new fastifyOtel.FastifyOtelInstrumentation({ registerOnInitialization: true }),
    );
  } catch {
    // not a Fastify app
  }

  type SdkInstrumentations = NonNullable<
    NonNullable<ConstructorParameters<typeof NodeSDK>[0]>['instrumentations']
  >;
  const sdk = new NodeSDK({ instrumentations: instrumentations as SdkInstrumentations });
  sdk.start();

  const shutdown = (): void => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
