import { Router, type Request, type Response } from "express";
import { getProvider } from "../providers/index.js";
import { configStore } from "../services/config-store.js";
import { stats } from "../services/stats.js";
import { mimeFromFilename } from "../utils/mime.js";
import { transcribe } from "../transcribe.js";
import { errorMessage } from "../../../../packages/error-middleware.js";
import { isValidLanguage, validateAudioBase64 } from "../utils/validate.js";

export const transcribeRouter: Router = Router();

export async function handleTranscribe(req: Request, res: Response) {
  const { audioBase64, filename, language, prompt, mode } = req.body as {
    audioBase64?: string;
    filename?: string;
    language?: string;
    prompt?: string;
    mode?: "raw" | "cleanup";
  };

  if (!audioBase64 || !filename) {
    res.status(400).json({ error: "audioBase64 and filename are required" });
    return;
  }

  const b64Error = validateAudioBase64(audioBase64);
  if (b64Error) {
    res.status(b64Error.includes("maximum size") ? 413 : 400).json({ error: b64Error });
    return;
  }

  // The local whisper provider passes language into a shell command — reject
  // anything that is not a plain BCP 47 tag before it reaches a provider.
  if (language !== undefined && !isValidLanguage(language)) {
    res.status(400).json({ error: `Invalid language value "${language}". Use BCP 47 code (e.g. "en", "en-US") or "auto".` });
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
      ...(prompt ? { prompt } : {}),
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
