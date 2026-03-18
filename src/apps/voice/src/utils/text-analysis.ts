/**
 * Pure text analysis functions for transcription metrics.
 */

const FILLER_WORDS = [
  "um", "uh", "uhh", "umm", "hmm", "hm",
  "like", "you know", "basically", "actually",
  "sort of", "kind of", "i mean", "right",
  "so", "well", "literally", "honestly",
];

// Multi-word fillers need special handling — match as phrases
const MULTI_WORD_FILLERS = FILLER_WORDS.filter((f) => f.includes(" "));
const SINGLE_WORD_FILLERS = new Set(
  FILLER_WORDS.filter((f) => !f.includes(" "))
);

export function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

export function calculateWPM(text: string, durationSec: number): number {
  if (durationSec <= 0) return 0;
  const words = countWords(text);
  return Math.round((words / durationSec) * 60);
}

export interface FillerWordResult {
  word: string;
  count: number;
}

export function detectFillerWords(text: string): FillerWordResult[] {
  if (!text.trim()) return [];
  const lower = text.toLowerCase();
  const counts = new Map<string, number>();

  // Count multi-word fillers first
  for (const phrase of MULTI_WORD_FILLERS) {
    const regex = new RegExp(`\\b${phrase}\\b`, "gi");
    const matches = lower.match(regex);
    if (matches && matches.length > 0) {
      counts.set(phrase, matches.length);
    }
  }

  // Count single-word fillers
  const words = lower.split(/\s+/);
  for (const word of words) {
    // Strip punctuation from edges
    const clean = word.replace(/^[^a-z]+|[^a-z]+$/g, "");
    if (SINGLE_WORD_FILLERS.has(clean)) {
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);
}
