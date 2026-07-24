import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const binary = resolve(process.env.KYOKAO_PTY_BIN ?? 'packages/cli/dist/kyokao.cjs');
if (!existsSync(binary)) {
  throw new Error(`Kyokao binary not found at ${binary}; build or set KYOKAO_PTY_BIN`);
}
if (process.platform === 'win32') {
  console.log(
    'PTY integration skipped on Windows: the harness requires POSIX pty/termios; fake-TTY integration remains covered by the Vitest suite.',
  );
  process.exit(0);
}
const python = process.env.KYOKAO_PTY_PYTHON ?? 'python3';
const result = spawnSync(python, [resolve('test/pty/kyokao_pty.py'), binary], {
  cwd: resolve('.'),
  stdio: 'inherit',
  timeout: 60_000,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`PTY integration passed: ${binary}`);
