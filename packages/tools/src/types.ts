

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
export type Approve = (action: string, detail: string) => Promise<boolean>;

export interface ToolResult {
  content: string;
  isError?: boolean;
  data?: unknown;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface ToolLimits {
  maxShellTimeoutMs: number;
  maxOutputChars: number;
  maxFileBytes: number;
  allowedHosts: string[];
}

export interface ToolExecutor {
  definitions(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close?(): Promise<void>;
}

export interface KyokaoPlugin {
  name: string;
  tools: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined>;
  close?(): Promise<void>;
}
