import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const children = [[], ['--module', 'ES2022', '--outDir', 'dist/esm']].map(
  (args) =>
    spawn(
      process.execPath,
      [compiler, '-p', 'tsconfig.json', '--watch', ...args],
      { stdio: 'inherit' },
    ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
for (const child of children)
  child.on('exit', (code) => {
    if (code) {
      for (const other of children) other.kill();
      process.exitCode = code;
    }
  });
