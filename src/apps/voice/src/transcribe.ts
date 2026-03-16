import { getProvider } from "./providers/index.js";
import type { TranscribeOptions, TranscriptionResult } from "./providers/types.js";

export type { TranscribeOptions, TranscriptionResult };

export async function transcribe(
  audio: File,
  options?: TranscribeOptions
): Promise<TranscriptionResult> {
  return getProvider().transcribe(audio, options);
}
