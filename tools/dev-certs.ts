/**
 * Local certificates in .certs/ (git-ignored):
 * - the gateway's HTTPS certificate: mkcert when installed (trusted by browsers),
 *   otherwise a self-signed ECDSA certificate via openssl (clients must trust
 *   .certs/dev-cert.pem or skip verification);
 * - a private CA for gRPC between workloads (grpc-ca.pem) and one server
 *   certificate it signed for localhost/127.0.0.1 (grpc-server.pem), always via openssl.
 *
 * Existing certificates are kept unless they expire within 30 days or (gRPC) fail a
 * TLS handshake check; works with OpenSSL 3+ and the LibreSSL that ships with macOS.
 *   pnpm certs [--force]
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:tls';
import { ROOT } from './lib.ts';

const dir = join(ROOT, '.certs');
const force = process.argv.includes('--force');
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1_000;
mkdirSync(dir, { recursive: true });

const has = (command: string) => {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'inherit' });

// A named-curve P-256 parameter file: `-newkey ec -pkeyopt ec_paramgen_curve:...` makes
// LibreSSL write explicit curve parameters, which Node's OpenSSL refuses.
const work = mkdtempSync(join(tmpdir(), 'ga-certs-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const curveParams = join(work, 'p256.pem');
openssl('ecparam', '-name', 'prime256v1', '-out', curveParams);
const newKey = ['-newkey', `ec:${curveParams}`, '-nodes', '-sha256'];

const expiresSoon = (file: string) =>
  Date.parse(new X509Certificate(readFileSync(file)).validTo) - Date.now() < RENEW_BEFORE_MS;

/** Why a client trusting `caFile` refuses `certFile` for localhost; undefined when it accepts it. */
async function tlsProblem(
  caFile: string,
  certFile: string,
  keyFile: string,
): Promise<string | undefined> {
  try {
    const server = createServer(
      { cert: readFileSync(certFile), key: readFileSync(keyFile) },
      (socket) => socket.end(),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      return await new Promise<string | undefined>((resolve) => {
        const socket = connect(
          { host: '127.0.0.1', port, servername: 'localhost', ca: readFileSync(caFile) },
          () => {
            socket.end();
            resolve(undefined);
          },
        );
        socket.on('error', (error) => resolve(error.message));
      });
    } finally {
      server.close();
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function httpsCertificate(): void {
  const cert = join(dir, 'dev-cert.pem');
  const key = join(dir, 'dev-key.pem');
  if (existsSync(cert) && existsSync(key) && !force) {
    if (!expiresSoon(cert)) {
      console.log(`certificate exists: ${cert} (use --force to regenerate)`);
      return;
    }
    console.log(`${cert} expires within 30 days: regenerating it`);
  }
  if (has('mkcert')) {
    execFileSync(
      'mkcert',
      ['-cert-file', cert, '-key-file', key, 'localhost', '127.0.0.1', '::1'],
      {
        stdio: 'inherit',
      },
    );
  } else {
    openssl(
      'req',
      '-x509',
      ...newKey,
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '397',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
      '-addext',
      'extendedKeyUsage=serverAuth',
    );
    console.log('self-signed certificate created (install mkcert for a browser-trusted one)');
  }
  console.log(`cert: ${cert}\nkey:  ${key}`);
}

/** CA + server certificate for gRPC TLS between the local services. */
async function grpcCertificates(): Promise<void> {
  const caCert = join(dir, 'grpc-ca.pem');
  const caKey = join(dir, 'grpc-ca-key.pem');
  const cert = join(dir, 'grpc-server.pem');
  const key = join(dir, 'grpc-server-key.pem');
  if ([caCert, caKey, cert, key].every((file) => existsSync(file)) && !force) {
    const expiring = [caCert, cert].find(expiresSoon);
    const problem = expiring
      ? `${expiring} expires within 30 days`
      : await tlsProblem(caCert, cert, key);
    if (!problem) {
      console.log(`gRPC certificates exist and verify: ${caCert} (use --force to regenerate)`);
      return;
    }
    console.log(`regenerating the gRPC certificates: ${problem}`);
  }
  openssl(
    'req',
    '-x509',
    ...newKey,
    '-keyout',
    caKey,
    '-out',
    caCert,
    '-days',
    '3650',
    '-subj',
    '/CN=global-architecture local gRPC CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  );
  const csr = join(work, 'server.csr');
  const extensions = join(work, 'server.ext');
  writeFileSync(
    extensions,
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
      '',
    ].join('\n'),
  );
  openssl('req', ...newKey, '-keyout', key, '-out', csr, '-subj', '/CN=localhost');
  openssl(
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-sha256',
    '-set_serial',
    `0x${randomBytes(16).toString('hex')}`,
    '-days',
    '397',
    '-extfile',
    extensions,
    '-out',
    cert,
  );
  const problem = await tlsProblem(caCert, cert, key);
  if (problem) {
    throw new Error(
      `the new gRPC certificates do not verify (${problem}); check which openssl is on PATH`,
    );
  }
  console.log(`gRPC CA:   ${caCert}\ngRPC cert: ${cert}\ngRPC key:  ${key}`);
}

httpsCertificate();
await grpcCertificates();
