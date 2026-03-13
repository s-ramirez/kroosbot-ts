import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { MemorySearchResult } from "./types.js";

type MemoryDocument = {
  path: string;
  lines: string[];
};

type MemoryEntryInput = {
  text: string;
  category?: string;
  tags?: string[];
  source?: string;
  sessionKey?: string;
};

type MemoryEntryBlock = {
  startLine: number;
  endLine: number;
  lines: string[];
  title?: string;
  category?: string;
  tags: string[];
  searchText: string;
};

export class MemoryManager {
  readonly enabled: boolean;
  private readonly rootDir: string;
  private readonly indexFile: string;
  private readonly maxResults: number;
  private readonly maxSnippetChars: number;

  constructor(config: AppConfig["memory"]) {
    this.enabled = config.enabled;
    this.rootDir = path.resolve(config.rootDir);
    this.indexFile = path.resolve(config.indexFile);
    this.maxResults = config.maxResults;
    this.maxSnippetChars = config.maxSnippetChars;
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    await fs.mkdir(this.rootDir, { recursive: true });
    await ensureFile(this.indexFile, "# Kroosbot Memory\n");
  }

  async search(query: string, options?: { maxResults?: number }): Promise<MemorySearchResult[]> {
    if (!this.enabled) return [];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const docs = await this.loadDocuments();
    const tokens = tokenize(normalizedQuery);
    const results: MemorySearchResult[] = [];

    for (const doc of docs) {
      for (const entry of splitIntoMemoryBlocks(doc.lines)) {
        const text = entry.lines.join("\n").trim();
        if (!text) continue;
        const score = scoreText(entry.searchText, normalizedQuery, tokens, {
          title: entry.title,
          category: entry.category,
          tags: entry.tags
        });
        if (score <= 0) continue;
        results.push({
          path: path.relative(process.cwd(), doc.path) || path.basename(doc.path),
          startLine: entry.startLine,
          endLine: entry.endLine,
          snippet: clampSnippet(text, this.maxSnippetChars),
          score,
          title: entry.title,
          category: entry.category,
          tags: entry.tags
        });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.maxResults ?? this.maxResults);
  }

  async appendNote(input: string | MemoryEntryInput, options?: { source?: string; sessionKey?: string }): Promise<string> {
    if (!this.enabled) {
      throw new Error("memory is disabled");
    }
    const entry = normalizeMemoryEntryInput(input, options);
    if (!entry.text) {
      throw new Error("memory note is empty");
    }

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const targetPath = path.join(this.rootDir, `${date}.md`);
    await ensureFile(targetPath, `# Memory ${date}\n\n`);

    const title = buildTitle(entry.text);
    const tags = entry.tags.length > 0 ? entry.tags : inferTags(entry.text, entry.category);
    const lines = [
      `## ${now.toISOString()} [${entry.category}] ${title}`,
      `- source: ${entry.source ?? "unknown"}`,
      `- session: ${entry.sessionKey ?? "unknown"}`,
      `- tags: ${tags.length > 0 ? tags.join(", ") : "none"}`,
      `- text: ${entry.text}`
    ];
    const block = `${lines.join("\n")}\n\n`;
    await fs.appendFile(targetPath, block, "utf8");
    return targetPath;
  }

  async hasSimilarNote(text: string, category?: string): Promise<boolean> {
    if (!this.enabled) return false;
    const normalizedText = text.trim().toLowerCase();
    if (!normalizedText) return false;

    const docs = await this.loadDocuments();
    for (const doc of docs) {
      for (const entry of splitIntoMemoryBlocks(doc.lines)) {
        const entryText = extractEntryText(entry.lines).toLowerCase();
        if (!entryText) continue;
        if (normalizeCategory(entry.category) !== normalizeCategory(category)) {
          continue;
        }
        if (entryText === normalizedText) {
          return true;
        }
      }
    }
    return false;
  }

  private async loadDocuments(): Promise<MemoryDocument[]> {
    const paths = new Set<string>([this.indexFile]);
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        paths.add(path.join(this.rootDir, entry.name));
      }
    }

    const docs: MemoryDocument[] = [];
    for (const filePath of paths) {
      const raw = await fs.readFile(filePath, "utf8").catch(() => "");
      if (!raw.trim()) continue;
      docs.push({ path: filePath, lines: raw.split(/\r?\n/) });
    }
    return docs;
  }
}

async function ensureFile(filePath: string, initialContents: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, initialContents, "utf8");
  }
}

function tokenize(text: string): string[] {
  return [...new Set(text.split(/[^a-z0-9_+-]+/i).map((token) => token.trim()).filter(Boolean))];
}

function scoreText(
  text: string,
  query: string,
  tokens: string[],
  metadata?: { title?: string; category?: string; tags?: string[] }
): number {
  let score = 0;
  if (text.includes(query)) score += 100;
  for (const token of tokens) {
    if (token.length >= 2 && text.includes(token)) score += 10;
  }
  const title = metadata?.title?.toLowerCase() ?? "";
  const category = metadata?.category?.toLowerCase() ?? "";
  const tags = metadata?.tags?.map((tag) => tag.toLowerCase()) ?? [];
  if (title && title.includes(query)) score += 35;
  if (category && tokens.includes(category)) score += 20;
  for (const token of tokens) {
    if (tags.includes(token)) score += 20;
  }
  return score;
}

function clampSnippet(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function splitIntoMemoryBlocks(lines: string[]): MemoryEntryBlock[] {
  const blocks: MemoryEntryBlock[] = [];
  let current: string[] = [];
  let startLine = 1;

  const pushCurrent = (endLine: number) => {
    if (current.length === 0) return;
    blocks.push(buildMemoryBlock(current, startLine, endLine));
    current = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    if (line.startsWith("## ")) {
      pushCurrent(lineNumber - 1);
      current = [line];
      startLine = lineNumber;
      continue;
    }
    if (!line.trim()) {
      pushCurrent(lineNumber - 1);
      startLine = lineNumber + 1;
      continue;
    }
    if (current.length === 0) {
      startLine = lineNumber;
    }
    current.push(line);
  }

  pushCurrent(lines.length);
  return blocks;
}

function buildMemoryBlock(lines: string[], startLine: number, endLine: number): MemoryEntryBlock {
  const titleLine = lines[0] ?? "";
  const titleMatch = titleLine.match(/^##\s+([^\[]+?)(?:\s+\[([^\]]+)\])?(?:\s+(.*))?$/);
  const category = titleMatch?.[2]?.trim().toLowerCase();
  const title = titleMatch?.[3]?.trim() || titleMatch?.[1]?.trim();
  const tagsLine = lines.find((line) => line.toLowerCase().startsWith("- tags:"));
  const tags = tagsLine
    ? tagsLine
        .slice("- tags:".length)
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const searchText = [title ?? "", category ?? "", tags.join(" "), lines.join("\n")]
    .join("\n")
    .toLowerCase();

  return {
    startLine,
    endLine,
    lines,
    title: title || undefined,
    category,
    tags,
    searchText
  };
}

function extractEntryText(lines: string[]): string {
  const textLine = lines.find((line) => line.toLowerCase().startsWith("- text:"));
  if (!textLine) {
    return lines.join("\n").trim();
  }
  return textLine.slice("- text:".length).trim();
}

function normalizeMemoryEntryInput(
  input: string | MemoryEntryInput,
  fallback?: { source?: string; sessionKey?: string }
): Required<Pick<MemoryEntryInput, "text" | "category" | "tags">> &
  Pick<MemoryEntryInput, "source" | "sessionKey"> {
  if (typeof input !== "string") {
    return {
      text: input.text.trim(),
      category: normalizeCategory(input.category),
      tags: dedupeTags(input.tags ?? []),
      source: input.source ?? fallback?.source,
      sessionKey: input.sessionKey ?? fallback?.sessionKey
    };
  }

  const parsed = parseStructuredMemoryText(input);
  return {
    text: parsed.text,
    category: parsed.category,
    tags: parsed.tags,
    source: fallback?.source,
    sessionKey: fallback?.sessionKey
  };
}

function parseStructuredMemoryText(raw: string): {
  text: string;
  category: string;
  tags: string[];
} {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]{1,31})\s*:\s*(.+)$/s);
  if (!match) {
    return {
      text: trimmed,
      category: inferCategory(trimmed),
      tags: inferTags(trimmed)
    };
  }
  const category = normalizeCategory(match[1] ?? "note");
  const text = (match[2] ?? "").trim();
  return {
    text,
    category,
    tags: inferTags(text, category)
  };
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(i like|i prefer|my favorite|favourite)\b/.test(lower)) return "preference";
  if (/\b(todo|need to|remember to|follow up|follow-up)\b/.test(lower)) return "todo";
  if (/\b(project|repo|codebase|implementation|architecture)\b/.test(lower)) return "project";
  if (/\b(decided|decision|we chose|we use)\b/.test(lower)) return "decision";
  return "note";
}

function buildTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 48) return cleaned;
  return `${cleaned.slice(0, 47).trimEnd()}...`;
}

function inferTags(text: string, category?: string): string[] {
  const tags = new Set<string>();
  if (category) tags.add(normalizeCategory(category));
  for (const token of tokenize(text.toLowerCase())) {
    if (token.length >= 4) {
      tags.add(token);
    }
    if (tags.size >= 6) break;
  }
  return [...tags];
}

function normalizeCategory(category: string | undefined): string {
  const normalized = (category ?? "").trim().toLowerCase();
  return normalized || "note";
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}
