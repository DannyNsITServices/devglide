import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { VOICE_DIR } from "../../../../packages/paths.js";
import {
  countWords,
  calculateWPM,
  detectFillerWords,
  type FillerWordResult,
} from "../utils/text-analysis.js";

let _dataDir = VOICE_DIR;
function historyFile(): string {
  return join(_dataDir, "history.json");
}

export interface HistoryEntry {
  id: string;
  text: string;
  cleanedText?: string;
  language?: string;
  duration?: number;
  wordCount: number;
  wpm: number;
  fillerWords: FillerWordResult[];
  provider: string;
  model: string;
  timestamp: string;
}

export interface AnalyticsSummary {
  totalTranscriptions: number;
  totalWords: number;
  totalDurationSec: number;
  avgWPM: number;
  topFillerWords: FillerWordResult[];
  recentTranscriptions: number; // last 24h
}

function loadHistory(): HistoryEntry[] {
  const file = historyFile();
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8")) as HistoryEntry[];
    }
  } catch {
    // corrupt file — start fresh
  }
  return [];
}

function saveHistory(entries: HistoryEntry[]): void {
  mkdirSync(_dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(historyFile(), JSON.stringify(entries, null, 2), {
    mode: 0o600,
  });
}

class HistoryStore {
  private static _instance: HistoryStore;
  private entries: HistoryEntry[];

  private constructor() {
    this.entries = loadHistory();
  }

  static getInstance(): HistoryStore {
    if (!HistoryStore._instance) {
      HistoryStore._instance = new HistoryStore();
    }
    return HistoryStore._instance;
  }

  append(params: {
    text: string;
    cleanedText?: string;
    language?: string;
    duration?: number;
    provider: string;
    model: string;
  }): HistoryEntry {
    const wordCount = countWords(params.text);
    const wpm =
      params.duration && params.duration > 0
        ? calculateWPM(params.text, params.duration)
        : 0;
    const fillerWords = detectFillerWords(params.text);

    const entry: HistoryEntry = {
      id: randomBytes(12).toString("hex"),
      text: params.text,
      cleanedText: params.cleanedText,
      language: params.language,
      duration: params.duration,
      wordCount,
      wpm,
      fillerWords,
      provider: params.provider,
      model: params.model,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(entry);

    // Keep max 500 entries
    if (this.entries.length > 500) {
      this.entries = this.entries.slice(-500);
    }

    saveHistory(this.entries);
    return entry;
  }

  list(limit = 25, offset = 0): { entries: HistoryEntry[]; total: number } {
    // Return newest first
    const reversed = [...this.entries].reverse();
    return {
      entries: reversed.slice(offset, offset + limit),
      total: this.entries.length,
    };
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  search(query: string, limit = 25): HistoryEntry[] {
    const lower = query.toLowerCase();
    return [...this.entries]
      .reverse()
      .filter(
        (e) =>
          e.text.toLowerCase().includes(lower) ||
          (e.cleanedText && e.cleanedText.toLowerCase().includes(lower))
      )
      .slice(0, limit);
  }

  getAnalytics(): AnalyticsSummary {
    const total = this.entries.length;
    if (total === 0) {
      return {
        totalTranscriptions: 0,
        totalWords: 0,
        totalDurationSec: 0,
        avgWPM: 0,
        topFillerWords: [],
        recentTranscriptions: 0,
      };
    }

    let totalWords = 0;
    let totalDuration = 0;
    let wpmSum = 0;
    let wpmCount = 0;
    const fillerAgg = new Map<string, number>();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let recentCount = 0;

    for (const entry of this.entries) {
      totalWords += entry.wordCount;
      if (entry.duration) totalDuration += entry.duration;
      if (entry.wpm > 0) {
        wpmSum += entry.wpm;
        wpmCount++;
      }
      for (const fw of entry.fillerWords) {
        fillerAgg.set(fw.word, (fillerAgg.get(fw.word) ?? 0) + fw.count);
      }
      if (new Date(entry.timestamp).getTime() > oneDayAgo) {
        recentCount++;
      }
    }

    const topFillerWords = Array.from(fillerAgg.entries())
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalTranscriptions: total,
      totalWords,
      totalDurationSec: Math.round(totalDuration * 10) / 10,
      avgWPM: wpmCount > 0 ? Math.round(wpmSum / wpmCount) : 0,
      topFillerWords,
      recentTranscriptions: recentCount,
    };
  }

  clear(): void {
    this.entries = [];
    saveHistory(this.entries);
  }

  /** Update cleaned text for an existing entry */
  updateCleanedText(id: string, cleanedText: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.cleanedText = cleanedText;
      saveHistory(this.entries);
    }
  }

  switchDataDir(dir: string): void {
    _dataDir = dir;
    this.entries = loadHistory();
  }
}

export const historyStore = HistoryStore.getInstance();
