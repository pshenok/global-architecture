/**
 * Creates a local TLS certificate for the gateway in .certs/ (git-ignored).
 * Uses mkcert when installed (the certificate is then trusted by browsers),
 * otherwise a self-signed ECDSA certificate via openssl (clients must trust
 * .certs/dev-cert.pem or skip verification).
 *   pnpm certs [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.ts';

const dir = join(ROOT, '.certs');
const cert = join(dir, 'dev-cert.pem');
const key = join(dir, 'dev-key.pem');

if (existsSync(cert) && existsSync(key) && !process.argv.includes('--force')) {
  console.log(`certificate exists: ${cert} (use --force to regenerate)`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });

const has = (command: string) => {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (has('mkcert')) {
  execFileSync('mkcert', ['-cert-file', cert, '-key-file', key, 'localhost', '127.0.0.1', '::1'], {
    stdio: 'inherit',
  });
} else {
  execFileSync(
    'openssl',
    [
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
    ],
    { stdio: 'inherit' },
  );
  console.log('self-signed certificate created (install mkcert for a browser-trusted one)');
}
console.log(`cert: ${cert}\nkey:  ${key}`);
