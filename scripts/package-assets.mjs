import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, 'packages', 'cli');
await mkdir(destination, { recursive: true });
await cp(join(root, 'README.md'), join(destination, 'README.md'));
await cp(join(root, 'LICENSE'), join(destination, 'LICENSE'));
await rm(join(destination, 'dist', 'kyokao.js'), { force: true });
