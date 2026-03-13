import path from "node:path";
import type { AppConfig } from "../config.js";
import type { MemoryManager } from "../memory/manager.js";
import type { Tool } from "./types.js";
import { createCodingTools } from "./codingTools.js";
import { createMemoryTools } from "./memoryTools.js";

export function createPiTools(config: AppConfig, memory: MemoryManager): Tool[] {
  const workspaceDir = path.resolve(config.app.workspaceDir);
  return [
    ...createMemoryTools(memory),
    ...createCodingTools(workspaceDir)
  ];
}
