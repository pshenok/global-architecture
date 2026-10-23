import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@grpc/grpc-js';
import { HealthImplementation } from 'grpc-health-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkGrpcHealth, closeHealthClients } from './health-client.ts';
import { channelCredentials, isLoopbackHost, serverCredentials, targetHost } from './tls.ts';

/** A throwaway CA and a localhost server certificate, made with openssl like `pnpm certs`. */
function makeCertificates(dir: string) {
  const file = (name: string) => join(dir, name);
  const curve = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  openssl(
    'req',
    '-x509',
    ...curve,
    '-keyout',
    file('ca-key.pem'),
    '-out',
    file('ca.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  );
  writeFileSync(
    file('ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  );
  openssl(
    'req',
    ...curve,
    '-keyout',
    file('key.pem'),
    '-out',
    file('csr'),
    '-subj',
    '/CN=localhost',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    file('csr'),
    '-CA',
    file('ca.pem'),
    '-CAkey',
    file('ca-key.pem'),
    '-set_serial',
    '0x01',
    '-days',
    '1',
    '-extfile',
    file('ext'),
    '-out',
    file('cert.pem'),
  );
  return { ca: file('ca.pem'), cert: file('cert.pem'), key: file('key.pem') };
}

describe('gRPC TLS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-tls-'));
  let certs: ReturnType<typeof makeCertificates>;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    certs = makeCertificates(dir);
    server = new Server();
    new HealthImplementation({ '': 'SERVING' }).addToServer(server);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        serverCredentials(
          { GRPC_TLS_CERT_FILE: certs.cert, GRPC_TLS_KEY_FILE: certs.key },
          '127.0.0.1',
        ),
        (error, bound) => (error ? reject(error) : resolve(bound)),
      ),
    );
    url = `127.0.0.1:${port}`;
  });

  afterAll(() => {
    closeHealthClients();
    server?.forceShutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves and verifies TLS with the CA', async () => {
    const byName = `localhost:${url.split(':')[1]}`;
    await expect(checkGrpcHealth(byName, { caFile: certs.ca })).resolves.toBe('SERVING');
    expect(() => channelCredentials(url, certs.ca)).toThrow(/use the host name/);
  });

  it('does not talk plaintext to a TLS server', async () => {
    await expect(checkGrpcHealth(url)).resolves.toBe('UNREACHABLE');
  });

  it('refuses plaintext anywhere but loopback', () => {
    expect(() => serverCredentials({}, '0.0.0.0')).toThrow(
      /refusing to serve plaintext gRPC on 0\.0\.0\.0/,
    );
    expect(() => serverCredentials({}, '127.0.0.1')).not.toThrow();
    expect(() => serverCredentials({}, 'localhost')).not.toThrow();
    expect(() => serverCredentials({ GRPC_TLS_CERT_FILE: certs.cert }, '127.0.0.1')).toThrow(
      /must be set together/,
    );
    expect(() => channelCredentials('user-service:50051', undefined)).toThrow(
      /refusing to call user-service:50051 over plaintext/,
    );
    expect(() => channelCredentials('127.0.0.1:50051', undefined)).not.toThrow();
  });

  it('names an unreadable certificate file', () => {
    expect(() => channelCredentials('localhost:1', join(dir, 'missing.pem'))).toThrow(
      /GRPC_TLS_CA_FILE=.*missing\.pem cannot be read/,
    );
  });

  it('recognises loopback hosts and target hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '10.0.0.1', 'user-service', 'localhost.evil.com', '::'])
      expect(isLoopbackHost(host)).toBe(false);
    expect(targetHost('user-service:50051')).toBe('user-service');
  });
});
