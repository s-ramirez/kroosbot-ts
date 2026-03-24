export type SubagentDefinition = {
  id: string;
  name: string;
  brainMode: "agent-sdk" | "openai-compatible";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  systemPrompt?: string;
  allowedTools: string[];
  skills: string[];
  createdAt: string;
  createdBy?: string;
};
