import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const apiFile = new URL('../apps/api/.env', import.meta.url);
if (!existsSync(apiFile)) {
  let source = readFileSync(
    new URL('../apps/api/.env.example', import.meta.url),
    'utf8',
  );
  for (const [name, length] of [
    ['TOKEN_ENCRYPTION_KEY', 32],
    ['ADMIN_PASSWORD', 18],
    ['SESSION_SECRET', 32],
  ])
    source = source.replace(
      `${name}=\n`,
      `${name}=${randomBytes(length).toString('hex')}\n`,
    );
  writeFileSync(apiFile, source, { mode: 0o600, flag: 'wx' });
  console.log(
    'Created apps/api/.env with random local secrets. Read ADMIN_PASSWORD there to sign in.',
  );
} else console.log('Kept existing apps/api/.env.');
const webFile = new URL('../apps/web/.env', import.meta.url);
if (!existsSync(webFile)) {
  writeFileSync(
    webFile,
    readFileSync(new URL('../apps/web/.env.example', import.meta.url)),
    { flag: 'wx' },
  );
  console.log('Created apps/web/.env.');
}
