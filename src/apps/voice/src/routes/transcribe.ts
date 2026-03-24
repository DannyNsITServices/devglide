import { Router, type Request, type Response } from "express";
import { getProvider } from "../providers/index.js";
import { configStore } from "../services/config-store.js";
import { stats } from "../services/stats.js";
import { mimeFromFilename } from "../utils/mime.js";
import { transcribe } from "../transcribe.js";
import { errorMessage } from "../../../../packages/error-middleware.js";

export const transcribeRouter: Router = Router();

export async function handleTranscribe(req: Request, res: Response) {
  const { audioBase64, filename, language, mode } = req.body as {
    audioBase64?: string;
    filename?: string;
    language?: string;
    mode?: "raw" | "cleanup";
  };

  if (!audioBase64 || !filename) {
    res.status(400).json({ error: "audioBase64 and filename are required" });
    return;
  }

  // Reject payloads larger than 25MB of base64 (~18.75MB decoded)
  if (audioBase64.length > 25 * 1024 * 1024) {
    res.status(413).json({ error: "audioBase64 exceeds maximum size (25MB)" });
    return;
  }

  // Validate base64: check length is valid and content uses only base64 chars.
  // Use a chunked regex to avoid catastrophic backtracking on large strings.
  const b64Len = audioBase64.length;
  if (b64Len % 4 !== 0) {
    res.status(400).json({ error: "audioBase64 is not valid base64" });
    return;
  }
  const b64ChunkRe = /^[A-Za-z0-9+/]*$/;
  const CHUNK = 64 * 1024; // validate in 64KB chunks
  let b64Valid = true;
  for (let off = 0; off < b64Len; off += CHUNK) {
    const slice = audioBase64.slice(off, Math.min(off + CHUNK, b64Len));
    // Allow trailing '=' only in the final chunk
    if (off + CHUNK >= b64Len) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(slice)) { b64Valid = false; break; }
    } else {
      if (!b64ChunkRe.test(slice)) { b64Valid = false; break; }
    }
  }
  if (!b64Valid) {
    res.status(400).json({ error: "audioBase64 is not valid base64" });
    return;
  }

  // Sanitize filename: strip path components, null bytes, and control characters
  const sanitizedFilename = filename
    .replace(/.*[/\\]/, "")           // strip path components
    .replace(/[\x00-\x1f\x7f]/g, ""); // strip null bytes & control chars

  if (!sanitizedFilename) {
    res.status(400).json({ error: "filename is invalid after sanitization" });
    return;
  }

  const startTime = Date.now();

  try {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(audioBase64, "base64");
    } catch {
      res.status(400).json({ error: "audioBase64 could not be decoded" });
      return;
    }
    const file = new File([buffer], sanitizedFilename, {
      type: mimeFromFilename(sanitizedFilename),
    });
    const cfg = configStore.get();
    const lang =
      language ?? (cfg.language !== "auto" ? cfg.language : undefined);
    const result = await transcribe(file, {
      language: lang,
      mode: mode ?? "raw",
    });
    const durationSec = (Date.now() - startTime) / 1000;
    stats.recordSuccess(result.duration ?? durationSec);
    res.json({ ok: true, ...result });
  } catch (err) {
    stats.recordError();
    res
      .status(500)
      .json({ ok: false, error: errorMessage(err) });
  }
}

transcribeRouter.post("/", handleTranscribe);
