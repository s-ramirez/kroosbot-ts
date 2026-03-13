export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  title?: string;
  category?: string;
  tags?: string[];
};
