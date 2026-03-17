import { getProvider } from "../providers/index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { VOICE_DIR } from "../../../../packages/paths.js";

let _dataDir = VOICE_DIR;
function statsFile(): string { return join(_dataDir, "stats.json"); }

export interface VoiceStats {
  provider: string;
  totalTranscriptions: number;
  totalDurationSec: number;
  totalErrors: number;
  lastTranscriptionAt: string | null;
  providerStatus: "configured" | "not_configured";
}

interface PersistedStats {
  totalTranscriptions: number;
  totalDurationSec: number;
  totalErrors: number;
  lastTranscriptionAt: string | null;
}

function loadStats(): PersistedStats {
  try {
    const file = statsFile();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch {}
  return { totalTranscriptions: 0, totalDurationSec: 0, totalErrors: 0, lastTranscriptionAt: null };
}

function saveStats(data: PersistedStats): void {
  mkdirSync(_dataDir, { recursive: true });
  writeFileSync(statsFile(), JSON.stringify(data, null, 2));
}

class StatsTracker {
  private static instance: StatsTracker;

  private totalTranscriptions: number;
  private totalDurationSec: number;
  private totalErrors: number;
  private lastTranscriptionAt: Date | null;

  private constructor() {
    const persisted = loadStats();
    this.totalTranscriptions = persisted.totalTranscriptions;
    this.totalDurationSec = persisted.totalDurationSec;
    this.totalErrors = persisted.totalErrors;
    this.lastTranscriptionAt = persisted.lastTranscriptionAt ? new Date(persisted.lastTranscriptionAt) : null;
  }

  static getInstance(): StatsTracker {
    if (!StatsTracker.instance) {
      StatsTracker.instance = new StatsTracker();
    }
    return StatsTracker.instance;
  }

  private flush(): void {
    saveStats({
      totalTranscriptions: this.totalTranscriptions,
      totalDurationSec: this.totalDurationSec,
      totalErrors: this.totalErrors,
      lastTranscriptionAt: this.lastTranscriptionAt?.toISOString() ?? null,
    });
  }

  recordSuccess(durationSec?: number) {
    this.totalTranscriptions++;
    if (durationSec) {
      this.totalDurationSec += durationSec;
    }
    this.lastTranscriptionAt = new Date();
    this.flush();
  }

  recordError() {
    this.totalErrors++;
    this.flush();
  }

  reset() {
    this.totalTranscriptions = 0;
    this.totalDurationSec = 0;
    this.totalErrors = 0;
    this.lastTranscriptionAt = null;
    this.flush();
  }

  getStats(): VoiceStats {
    const provider = getProvider();
    return {
      provider: provider.name,
      totalTranscriptions: this.totalTranscriptions,
      totalDurationSec: Math.round(this.totalDurationSec * 100) / 100,
      totalErrors: this.totalErrors,
      lastTranscriptionAt: this.lastTranscriptionAt?.toISOString() ?? null,
      providerStatus: provider.isConfigured()
        ? "configured"
        : "not_configured",
    };
  }

  /** Switch to a new data directory (e.g. per-project) and reload stats. */
  switchDataDir(dir: string): void {
    _dataDir = dir;
    const persisted = loadStats();
    this.totalTranscriptions = persisted.totalTranscriptions;
    this.totalDurationSec = persisted.totalDurationSec;
    this.totalErrors = persisted.totalErrors;
    this.lastTranscriptionAt = persisted.lastTranscriptionAt ? new Date(persisted.lastTranscriptionAt) : null;
  }
}

export const stats = StatsTracker.getInstance();
