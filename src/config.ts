import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const openAiCompatibleBrainSchema = z.object({
  baseUrl: z.string().default("http://127.0.0.1:8080/v1"),
  model: z.string().default(""),
  apiKey: z.string().default(""),
  temperature: z.number().default(0.2),
  maxOutputTokens: z.number().int().positive().default(300),
  requestTimeoutMs: z.number().int().positive().default(60000)
});

const claudeBrainSchema = z.object({
  apiKey: z.string().default(""),
  model: z.string().default("claude-opus-4-6"),
  maxOutputTokens: z.number().int().positive().default(1024)
});

const schema = z.object({
  app: z.object({
    listenPort: z.number().int().positive().default(8788),
    historyLimit: z.number().int().positive().default(16),
    workspaceDir: z.string().default(".")
  }),
  brain: z.object({
    mode: z.enum(["echo", "openai-compatible", "claude"]).default("openai-compatible"),
    systemPrompt: z.string().default("You are Kroosbot. Keep replies short and practical."),
    historyWindow: z.number().int().positive().default(10),
    echoPrefix: z.string().default("Kroosbot:"),
    openAiCompatible: openAiCompatibleBrainSchema.default({}),
    claude: claudeBrainSchema.default({}),
    tools: z.object({
      enabled: z.boolean().default(true),
      maxSteps: z.number().int().positive().default(3)
    }).default({})
  }),
  memory: z.object({
    enabled: z.boolean().default(true),
    rootDir: z.string().default("./memory"),
    indexFile: z.string().default("MEMORY.md"),
    maxResults: z.number().int().positive().default(4),
    maxSnippetChars: z.number().int().positive().default(600),
    autoRemember: z.object({
      enabled: z.boolean().default(true),
      categories: z.array(z.enum(["preference", "decision"])).default(["preference", "decision"])
    }).default({})
  }),
  adapters: z.object({
    discord: z.object({
      enabled: z.boolean().default(false),
      token: z.string().default(""),
      requireMention: z.boolean().default(true),
      allowedChannelIds: z.array(z.string()).default([]),
      mentionRoleIds: z.array(z.string()).default([])
    }),
    imessage: z.object({
      enabled: z.boolean().default(true),
      serverUrl: z.string(),
      password: z.string(),
      webhookPath: z.string().default("/imessage/webhook"),
      requestTimeoutMs: z.number().int().positive().default(10000),
      markAsRead: z.boolean().default(false),
      sendTyping: z.boolean().default(true)
    })
  })
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  const filePath = process.env.KROOSBOT_CONFIG?.trim()
    ? path.resolve(process.env.KROOSBOT_CONFIG)
    : path.resolve("config.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return schema.parse(parsed);
}
