import { resolve } from 'node:path';
import type { KyokaoPlugin, ToolDefinition, ToolExecutor, ToolResult } from './types.js';

class PluginTools implements ToolExecutor {
  constructor(private readonly plugin: KyokaoPlugin) {}
  definitions(): ToolDefinition[] {
    return this.plugin.tools;
  }
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (
      (await this.plugin.execute(name, args)) ?? {
        content: `Plugin ${this.plugin.name} does not implement ${name}`,
        isError: true,
      }
    );
  }
  async close(): Promise<void> {
    await this.plugin.close?.();
  }
}

export function validToolDefinition(value: unknown): value is ToolDefinition {
  const definition = value as ToolDefinition;
  return (
    !!definition &&
    definition.type === 'function' &&
    typeof definition.function?.name === 'string' &&
    typeof definition.function?.description === 'string' &&
    !!definition.function.parameters &&
    typeof definition.function.parameters === 'object'
  );
}

export async function loadPlugins(paths: string[], cwd = process.cwd()): Promise<ToolExecutor[]> {
  const loaded: ToolExecutor[] = [];
  try {
    for (const rawPath of paths) {
      const path = resolve(cwd, rawPath);
      const module = await import(path);
      const plugin = (module.default ?? module.plugin) as Partial<KyokaoPlugin> | undefined;
      if (
        !plugin ||
        typeof plugin.name !== 'string' ||
        !Array.isArray(plugin.tools) ||
        !plugin.tools.every(validToolDefinition) ||
        typeof plugin.execute !== 'function'
      )
        throw new Error(`Invalid Kyokao plugin: ${rawPath}`);
      loaded.push(new PluginTools(plugin as KyokaoPlugin));
    }
    return loaded;
  } catch (error) {
    await Promise.allSettled(loaded.map((plugin) => plugin.close?.()));
    throw error;
  }
}
