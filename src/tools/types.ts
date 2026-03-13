export type ToolParameter = {
  name: string;
  type: "string";
  description: string;
  required?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameter[];
  approvalMode?: "none" | "always";
};

export type ToolExecutionResult = {
  ok: boolean;
  content: string;
  requiresApproval?: boolean;
  approvalId?: string;
};

export interface Tool {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

export type ToolExecutionContext = {
  sessionKey: string;
};

export type PendingToolApproval = {
  id: string;
  sessionKey: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestedAt: string;
};
