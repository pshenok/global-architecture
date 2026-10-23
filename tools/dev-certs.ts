/**
 * Local certificates in .certs/ (git-ignored):
 * - the gateway's HTTPS certificate: mkcert when installed (trusted by browsers),
 *   otherwise a self-signed ECDSA certificate via openssl (clients must trust
 *   .certs/dev-cert.pem or skip verification);
 * - a private CA for gRPC between workloads (grpc-ca.pem) and one server
 *   certificate it signed for localhost/127.0.0.1 (grpc-server.pem), always via openssl.
 *   pnpm certs [--force]
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

const dir = join(ROOT, '.certs');
const force = process.argv.includes('--force');
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

function httpsCertificate(): void {
  const cert = join(dir, 'dev-cert.pem');
  const key = join(dir, 'dev-key.pem');
  if (existsSync(cert) && existsSync(key) && !force) {
    console.log(`certificate exists: ${cert} (use --force to regenerate)`);
    return;
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
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
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
function grpcCertificates(): void {
  const caCert = join(dir, 'grpc-ca.pem');
  const caKey = join(dir, 'grpc-ca-key.pem');
  const cert = join(dir, 'grpc-server.pem');
  const key = join(dir, 'grpc-server-key.pem');
  if ([caCert, caKey, cert, key].every((file) => existsSync(file)) && !force) {
    console.log(`gRPC certificates exist: ${caCert} (use --force to regenerate)`);
    return;
  }
  const curve = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  openssl(
    'req',
    '-x509',
    ...curve,
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
  const work = mkdtempSync(join(tmpdir(), 'ga-certs-'));
  try {
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
    openssl('req', ...curve, '-keyout', key, '-out', csr, '-subj', '/CN=localhost');
    openssl(
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-set_serial',
      `0x${randomBytes(16).toString('hex')}`,
      '-days',
      '397',
      '-extfile',
      extensions,
      '-out',
      cert,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`gRPC CA:   ${caCert}\ngRPC cert: ${cert}\ngRPC key:  ${key}`);
}

httpsCertificate();
grpcCertificates();
