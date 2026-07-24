import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

const comparablePath = (path: string) => {
  const withoutDevicePrefix =
    process.platform === 'win32'
      ? path.startsWith('\\\\?\\UNC\\')
        ? `\\\\${path.slice(8)}`
        : path.startsWith('\\\\?\\')
          ? path.slice(4)
          : path
      : path;
  const normalized = resolve(withoutDevicePrefix);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const isWithin = (root: string, candidate: string) => {
  const path = relative(comparablePath(root), comparablePath(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export class WorkspaceSandbox {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async path(input: unknown): Promise<string> {
    if (typeof input !== 'string' || !input || input.includes('\0'))
      throw new Error('path must be a non-empty string');
    const target = resolve(this.root, input);
    if (!isWithin(this.root, target)) throw new Error('Path escapes workspace');
    const canonicalRoot = await realpath(this.root);
    let ancestor = target;
    while (true) {
      try {
        const actual = await realpath(ancestor);
        if (!isWithin(canonicalRoot, actual)) throw new Error('Symlink escapes workspace');
        break;
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new Error('Path has no existing ancestor');
        ancestor = parent;
      }
    }
    return target;
  }
}
