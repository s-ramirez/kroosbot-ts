export type AutoMemoryCandidate = {
  category: "preference" | "decision";
  text: string;
};

export function extractAutoMemoryCandidate(text: string): AutoMemoryCandidate | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return null;
  if (/[?]$/.test(trimmed)) return null;

  const preference = extractPreference(trimmed);
  if (preference) return preference;

  const decision = extractDecision(trimmed);
  if (decision) return decision;

  return null;
}

function extractPreference(text: string): AutoMemoryCandidate | null {
  const normalized = text.trim();
  if (!/^(i\s+(?:really\s+|definitely\s+|honestly\s+|actually\s+|personally\s+|generally\s+|usually\s+|kind\s+of\s+|kinda\s+|quite\s+|very\s+)?(like|love|prefer)|my favorite|my favourite)\b/i.test(normalized)) {
    return null;
  }
  return {
    category: "preference",
    text: normalized
  };
}

function extractDecision(text: string): AutoMemoryCandidate | null {
  const normalized = text.trim();
  if (
    !/^(we\s+(decided|chose|use)|i\s+decided|the\s+decision\s+is)\b/i.test(normalized)
  ) {
    return null;
  }
  return {
    category: "decision",
    text: normalized
  };
}
