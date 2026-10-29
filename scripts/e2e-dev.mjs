import { createServer } from 'wxt';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'glintab-dev-server-'));
let server;
try {
  // Exercise serve mode, not a build with --mode development. Never overwrite
  // the user's running dev extension or stop their localhost:3000 server.
  server = await createServer({
    root,
    outDir: path.join(temporary, 'output'),
    webExt: { disabled: true },
    dev: { server: { host: 'localhost', port: 3100, strictPort: false } },
  });
  await server.start();
  const child = spawn(process.execPath, [path.join(root, 'scripts/e2e.mjs'), '--dev'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      GLINTAB_E2E_EXTENSION_DIR: path.join(temporary, 'output/chrome-mv3-dev'),
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await server?.stop();
  await rm(temporary, { recursive: true, force: true });
}
