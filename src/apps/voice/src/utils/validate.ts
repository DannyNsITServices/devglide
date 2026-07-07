/** Shared input validation for the transcription entry points (REST + MCP). */

/**
 * BCP 47 language tag (e.g. "en", "en-US") or "auto".
 * The local whisper provider interpolates the language into a shell command
 * (nodejs-whisper does not escape it), so this must stay strict.
 */
export function isValidLanguage(language: string): boolean {
  return language === "auto" || /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(language);
}

/** Max accepted base64 payload (~18.75MB decoded). */
export const MAX_AUDIO_BASE64_LENGTH = 25 * 1024 * 1024;

/**
 * Validate a base64 audio payload: size cap, length multiple of 4, and
 * charset. Chunked regex to avoid catastrophic backtracking on large strings.
 * Returns an error message, or null when valid.
 */
export function validateAudioBase64(audioBase64: string): string | null {
  if (audioBase64.length > MAX_AUDIO_BASE64_LENGTH) {
    return "audioBase64 exceeds maximum size (25MB)";
  }
  const b64Len = audioBase64.length;
  if (b64Len % 4 !== 0) {
    return "audioBase64 is not valid base64";
  }
  const b64ChunkRe = /^[A-Za-z0-9+/]*$/;
  const CHUNK = 64 * 1024;
  for (let off = 0; off < b64Len; off += CHUNK) {
    const slice = audioBase64.slice(off, Math.min(off + CHUNK, b64Len));
    // Allow trailing '=' only in the final chunk
    if (off + CHUNK >= b64Len) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(slice)) return "audioBase64 is not valid base64";
    } else {
      if (!b64ChunkRe.test(slice)) return "audioBase64 is not valid base64";
    }
  }
  return null;
}
