import pc from 'picocolors';

export const theme = {
  brand: (value: string) => pc.bold(pc.cyan(value)),
  muted: (value: string) => pc.dim(value),
  user: (value: string) => pc.cyan(value),
  assistant: (value: string) => pc.green(value),
  tool: (value: string) => pc.yellow(value),
  error: (value: string) => pc.red(value),
};
