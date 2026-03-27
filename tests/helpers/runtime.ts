import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryManager } from "../../src/memory/manager.js";
import { RuntimeStore } from "../../src/runtime-store/store.js";

export async function createTempRuntimeStore(historyLimit = 20): Promise<{
  runtime: RuntimeStore;
  dbPath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kroosbot-test-runtime-"));
  const dbPath = path.join(tempDir, "runtime.sqlite");
  const runtime = new RuntimeStore({ enabled: true, dbPath }, historyLimit);
  runtime.initialize();

  return {
    runtime,
    dbPath,
    cleanup: async () => {
      try {
        runtime.close();
      } catch {
        // ignore repeated close during tests that reopen the database
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

export async function createTempMemoryConfig(): Promise<{
  config: ConstructorParameters<typeof MemoryManager>[0];
  cleanup: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kroosbot-test-memory-"));
  return {
    config: {
      enabled: true,
      rootDir: path.join(tempDir, "memory"),
      indexFile: path.join(tempDir, "MEMORY.md"),
      maxResults: 5,
      maxSnippetChars: 300,
      autoRemember: {
        enabled: false,
        categories: ["preference", "decision", "todo", "project", "note"]
      }
    },
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}
