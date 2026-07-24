// @ts-nocheck
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type {
    ApprovalMode,
    Approve,
    ToolDefinition,
    ToolExecutor,
    ToolLimits,
    ToolResult,
} from './types.js';
import { WorkspaceSandbox } from './sandbox.js';
// Public API re-exports — the package surface is unchanged for consumers.
export * from './types.js';
export { WorkspaceSandbox } from './sandbox.js';
export { loadPlugins } from './plugins.js';
export { connectMcp, McpRequestTimeoutError, McpStartupTimeoutError, } from './mcp.js';
const run = promisify(execFile);
const DEFAULT_MAX_OUTPUT = 30_000;
const DEFAULT_MAX_SHELL_TIMEOUT = 120_000;
const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const clipped = (s, max = DEFAULT_MAX_OUTPUT) => s.length > max ? `${s.slice(0, max)}\n…truncated…` : s;
const spec = (name, description, properties, required = []) => ({
    type: 'function',
    function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
    },
});
/**
 * The nine workspace-scoped core tools (read, list, glob, grep, write, patch,
 * shell, read-only git, http_get) with permission gating and safety limits.
 * Kept as a single cohesive class — its private methods share `sandbox`,
 * `limits`, `approval`, and the `clipped`/`spec` helpers, and splitting them
 * per-tool would create churn without cohesion gain.
 */
export class CoreTools {
    constructor(
        private readonly sandbox: WorkspaceSandbox,
        private readonly approval: ApprovalMode,
        private readonly approve: Approve = async () => false,
        private readonly limits: ToolLimits = {
        maxShellTimeoutMs: DEFAULT_MAX_SHELL_TIMEOUT,
        maxOutputChars: DEFAULT_MAX_OUTPUT,
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
        allowedHosts: [],
    }) {}
    definitions(): ToolDefinition[] {
        return [
            spec('read_file', 'Read a UTF-8 file', { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, ['path']),
            spec('list_files', 'List a directory tree', { path: { type: 'string' }, depth: { type: 'integer' } }, []),
            spec('glob', 'Find files by simple glob', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
            spec('grep', 'Search files using a regex', { query: { type: 'string' }, path: { type: 'string' } }, ['query']),
            spec('write_file', 'Create or replace a UTF-8 file', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
            spec('apply_patch', 'Replace exact text in a file', { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, ['path', 'search', 'replace']),
            spec('shell', 'Execute a command in the workspace', { command: { type: 'string' }, timeoutMs: { type: 'number' } }, ['command']),
            spec('git', 'Run a read-only git subcommand', { args: { type: 'array', items: { type: 'string' } } }, ['args']),
            spec('http_get', 'Fetch a HTTP(S) URL', { url: { type: 'string' } }, ['url']),
        ];
    }
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        try {
            switch (name) {
                case 'read_file':
                    return await this.read(args);
                case 'list_files':
                    return await this.list(args);
                case 'glob':
                    return await this.glob(args);
                case 'grep':
                    return await this.grep(args);
                case 'write_file':
                    return await this.write(args);
                case 'apply_patch':
                    return await this.patch(args);
                case 'shell':
                    return await this.shell(args);
                case 'git':
                    return await this.git(args);
                case 'http_get':
                    return await this.http(args);
                default:
                    return { content: `Unknown tool: ${name}`, isError: true };
            }
        }
        catch (e) {
            return { content: e instanceof Error ? e.message : String(e), isError: true };
        }
    }
    async allowed(action, detail) {
        return (this.approval === 'full-auto' ||
            (this.approval === 'auto-edit' && (action === 'write_file' || action === 'apply_patch')) ||
            (await this.approve(action, detail)));
    }
    async read(a) {
        const path = await this.sandbox.path(a.path);
        if ((await stat(path)).size > this.limits.maxFileBytes)
            throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
        const text = await readFile(path, 'utf8');
        const start = typeof a.startLine === 'number' ? a.startLine : 1, end = typeof a.endLine === 'number' ? a.endLine : undefined;
        const out = text
            .split('\n')
            .slice(start - 1, end)
            .map((l, i) => `${start + i}: ${l}`)
            .join('\n');
        return { content: clipped(out, this.limits.maxOutputChars) };
    }
    async list(a) {
        const depth = Math.min(typeof a.depth === 'number' ? a.depth : 2, 5), out = [];
        const walk = async (d, n) => {
            for (const e of await readdir(d, { withFileTypes: true })) {
                if (['.git', 'node_modules', 'dist'].includes(e.name))
                    continue;
                const f = resolve(d, e.name);
                out.push(`${e.isDirectory() ? 'd' : 'f'} ${relative(this.sandbox.root, f)}`);
                if (e.isDirectory() && n < depth && out.length < 500)
                    await walk(f, n + 1);
            }
        };
        await walk(await this.sandbox.path(a.path ?? '.'), 0);
        return { content: clipped(out.join('\n'), this.limits.maxOutputChars), data: out };
    }
    async glob(a) {
        if (typeof a.pattern !== 'string')
            throw new Error('pattern must be a string');
        const regex = new RegExp('^' +
            a.pattern
                .split('*')
                .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                .join('.*') +
            '$');
        const tree = await this.list({ path: a.path ?? '.', depth: 5 });
        const found = tree.data
            .filter((x) => x.startsWith('f ') && regex.test(x.slice(2)))
            .map((x) => x.slice(2));
        return { content: clipped(found.join('\n'), this.limits.maxOutputChars), data: found };
    }
    async grep(a) {
        if (typeof a.query !== 'string')
            throw new Error('query must be a string');
        const re = new RegExp(a.query, 'g'), root = await this.sandbox.path(a.path ?? '.'), out = [];
        const walk = async (d) => {
            for (const e of await readdir(d, { withFileTypes: true })) {
                if (['.git', 'node_modules', 'dist'].includes(e.name))
                    continue;
                const f = resolve(d, e.name);
                if (e.isDirectory())
                    await walk(f);
                else {
                    try {
                        const t = await readFile(f, 'utf8');
                        t.split('\n').forEach((l, i) => {
                            re.lastIndex = 0;
                            if (re.test(l) && out.length < 200)
                                out.push(`${relative(this.sandbox.root, f)}:${i + 1}:${l}`);
                        });
                    }
                    catch { }
                }
            }
        };
        await walk(root);
        return { content: clipped(out.join('\n'), this.limits.maxOutputChars), data: out };
    }
    async write(a) {
        if (typeof a.content !== 'string')
            throw new Error('content must be a string');
        if (Buffer.byteLength(a.content) > this.limits.maxFileBytes)
            throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
        const path = await this.sandbox.path(a.path);
        if (!(await this.allowed('write_file', path)))
            return { content: 'Permission denied', isError: true };
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, a.content);
        return { content: `Wrote ${String(a.path)}` };
    }
    async patch(a) {
        if (typeof a.search !== 'string' || typeof a.replace !== 'string')
            throw new Error('search and replace must be strings');
        const path = await this.sandbox.path(a.path);
        if (!(await this.allowed('apply_patch', path)))
            return { content: 'Permission denied', isError: true };
        if ((await stat(path)).size > this.limits.maxFileBytes)
            throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
        const before = await readFile(path, 'utf8');
        const first = before.indexOf(a.search);
        if (!a.search || first < 0 || first !== before.lastIndexOf(a.search))
            return { content: 'Search text must occur exactly once', isError: true };
        const updated = before.replace(a.search, a.replace);
        if (Buffer.byteLength(updated) > this.limits.maxFileBytes)
            throw new Error(`File exceeds safety limit of ${this.limits.maxFileBytes} bytes`);
        await writeFile(path, updated);
        return { content: `Patched ${String(a.path)}` };
    }
    async shell(a) {
        if (typeof a.command !== 'string')
            throw new Error('command must be a string');
        if (!(await this.allowed('shell', a.command)))
            return { content: 'Permission denied', isError: true };
        const timeout = Math.min(Math.max(typeof a.timeoutMs === 'number' ? a.timeoutMs : 30000, 1000), this.limits.maxShellTimeoutMs);
        const cmd = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh', args = process.platform === 'win32' ? ['/d', '/s', '/c', a.command] : ['-lc', a.command];
        try {
            const r = await run(cmd, args, {
                cwd: this.sandbox.root,
                timeout,
                maxBuffer: this.limits.maxOutputChars * 2,
            });
            return {
                content: clipped((r.stdout ?? '') + (r.stderr ?? ''), this.limits.maxOutputChars),
            };
        }
        catch (e) {
            return {
                content: clipped(`${e.stdout ?? ''}${e.stderr ?? ''}\nexit code: ${e.code ?? 'unknown'}`, this.limits.maxOutputChars),
                isError: true,
            };
        }
    }
    async git(a) {
        if (!Array.isArray(a.args) ||
            !a.args.every((x) => typeof x === 'string') ||
            !['status', 'diff', 'log', 'show', 'branch'].includes(a.args[0]) ||
            a.args.some((value) =>
                ['--no-index', '--ext-diff', '--textconv'].includes(value) ||
                value.includes('\0') ||
                value === '..' ||
                value.startsWith('../') ||
                value.startsWith('..\\') ||
                /^[a-zA-Z]:[\\/]/.test(value) ||
                value.startsWith('/') ||
                value.startsWith('\\\\')))
            return {
                content: 'Only workspace-scoped, read-only git status/diff/log/show/branch arguments are allowed',
                isError: true,
            };
        const r = await run('git', a.args, {
            cwd: this.sandbox.root,
            timeout: 30000,
            maxBuffer: this.limits.maxOutputChars * 2,
        });
        return { content: clipped(r.stdout + r.stderr, this.limits.maxOutputChars) };
    }
    async http(a) {
        if (typeof a.url !== 'string')
            throw new Error('url must be a string');
        const url = new URL(a.url);
        if (!['http:', 'https:'].includes(url.protocol))
            throw new Error('Only HTTP(S) URLs allowed');
        if (url.username || url.password)
            throw new Error('HTTP URLs containing credentials are not allowed');
        const allowedHosts = this.limits.allowedHosts.map((host) => host.toLowerCase());
        const signal = AbortSignal.timeout(30000);
        let current = url;
        for (let redirects = 0; redirects <= 5; redirects++) {
            if (allowedHosts.length && !allowedHosts.includes(current.hostname.toLowerCase()))
                throw new Error(`Network host is not allowed: ${current.hostname}`);
            const response = await fetch(current, { signal, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                await response.body?.cancel();
                if (!location)
                    return { content: `HTTP ${response.status} redirect without a location`, isError: true };
                if (redirects === 5)
                    return { content: 'HTTP redirect limit exceeded', isError: true };
                current = new URL(location, current);
                if (!['http:', 'https:'].includes(current.protocol))
                    throw new Error('Only HTTP(S) redirect URLs allowed');
                if (current.username || current.password)
                    throw new Error('HTTP redirect URLs containing credentials are not allowed');
                continue;
            }
            const reader = response.body?.getReader();
            if (!reader)
                return { content: '', isError: !response.ok };
            const decoder = new TextDecoder();
            let content = '';
            let truncated = false;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    content += decoder.decode(value, { stream: true });
                    if (content.length > this.limits.maxOutputChars) {
                        truncated = true;
                        await reader.cancel();
                        break;
                    }
                }
                if (!truncated)
                    content += decoder.decode();
            }
            finally {
                reader.releaseLock();
            }
            return {
                content: truncated
                    ? `${content.slice(0, this.limits.maxOutputChars)}\n…truncated…`
                    : content,
                isError: !response.ok,
            };
        }
        return { content: 'HTTP redirect limit exceeded', isError: true };
    }
}
/** Composes multiple {@link ToolExecutor}s into one; dispatches by tool name. */
export class CompositeTools {
    constructor(private readonly executors: ToolExecutor[]) {}
    definitions(): ToolDefinition[] {
        return this.executors.flatMap((executor) => executor.definitions());
    }
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        for (const executor of this.executors) {
            if (executor.definitions().some((definition) => definition.function.name === name))
                return executor.execute(name, args);
        }
        return { content: `Unknown tool: ${name}`, isError: true };
    }
    async close(): Promise<void> {
        await Promise.all(this.executors.map((executor) => executor.close?.()));
    }
}
