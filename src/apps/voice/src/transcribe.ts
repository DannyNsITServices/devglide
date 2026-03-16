import { getProvider, getProviderConfig } from "./providers/index.js";
import type { TranscribeOptions, TranscriptionResult } from "./providers/types.js";
import { buildVocabPrompt } from "./services/prompt-builder.js";
import { historyStore } from "./services/history-store.js";
import { cleanupText } from "./services/cleanup.js";

export type { TranscribeOptions, TranscriptionResult };

export interface TranscribeResult extends TranscriptionResult {
  cleanedText?: string;
  historyId?: string;
}

export async function transcribe(
  audio: File,
  options?: TranscribeOptions & { mode?: "raw" | "cleanup" }
): Promise<TranscribeResult> {
  // Build vocabulary prompt if biasing is enabled and no explicit prompt given
  const vocabPrompt = options?.prompt ?? (await buildVocabPrompt());
  const opts: TranscribeOptions = {
    ...options,
    ...(vocabPrompt ? { prompt: vocabPrompt } : {}),
  };

  const result = await getProvider().transcribe(audio, opts);

  // Normalize whitespace: collapse newlines/runs of spaces into single spaces
  // so multi-segment transcriptions always produce one continuous line.
  result.text = result.text.replace(/\s+/g, " ").trim();

  // AI cleanup if requested
  let cleanedText: string | undefined;
  if (options?.mode === "cleanup") {
    try {
      cleanedText = await cleanupText(result.text);
    } catch {
      // Cleanup failed — return raw text, don't block transcription
    }
  }

  // Record in history
  const providerCfg = getProviderConfig();
  const entry = historyStore.append({
    text: result.text,
    cleanedText,
    language: result.language,
    duration: result.duration,
    provider: providerCfg.name,
    model: providerCfg.model,
  });

  return {
    ...result,
    cleanedText,
    historyId: entry.id,
  };
}
