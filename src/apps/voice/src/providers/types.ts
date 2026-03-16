export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface TranscribeOptions {
  language?: string;
  responseFormat?: "json" | "text" | "verbose_json";
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly displayName: string;
  readonly requiresApiKey: boolean;
  transcribe(audio: File, options?: TranscribeOptions): Promise<TranscriptionResult>;
  isConfigured(): boolean;
}

export interface ProviderConfig {
  name: string;
  displayName: string;
  apiKey?: string;
  baseURL?: string;
  model: string;
  requiresApiKey: boolean;
}
