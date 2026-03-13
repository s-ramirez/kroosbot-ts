import { z } from "zod";

export const evalCaseSchema = z.object({
  name: z.string().min(1),
  input: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(["user", "assistant", "system"]),
    text: z.string()
  })).default([]),
  workspaceFiles: z.array(z.object({
    path: z.string().min(1),
    content: z.string()
  })).default([]),
  memoryNotes: z.array(z.object({
    text: z.string().min(1),
    category: z.string().optional()
  })).default([]),
  expected: z.object({
    mustCallAll: z.array(z.string()).default([]),
    mustCallAnyOf: z.array(z.string()).default([]),
    mustNotCall: z.array(z.string()).default([]),
    finalAnswerContains: z.array(z.string()).default([]),
    finalAnswerNotContains: z.array(z.string()).default([])
  })
});

export const evalSuiteSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(evalCaseSchema).min(1)
});

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export type EvalCaseResult = {
  name: string;
  passed: boolean;
  failures: string[];
  finalAnswer: string;
  calledTools: string[];
  trace: Array<{
    step: number;
    toolName: string;
    ok: boolean;
    requiresApproval?: boolean;
    approvalId?: string;
    arguments: Record<string, unknown>;
    content: string;
  }>;
};
