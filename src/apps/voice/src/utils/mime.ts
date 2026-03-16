/** Canonical extension-to-MIME mapping for audio files. */
const mimeMap: Record<string, string> = {
  ogg: "audio/ogg",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  webm: "audio/webm",
};

/** Return the audio MIME type for a filename, defaulting to `audio/webm`. */
export function mimeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return mimeMap[ext || ""] || "audio/webm";
}
