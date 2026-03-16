export interface VoiceWidgetOptions {
  /** Base URL of the voice app, e.g. 'http://localhost:7004' */
  voiceUrl: string;
  /** Called with the transcribed text when transcription succeeds */
  onResult: (text: string) => void;
  /** Called with an Error when something goes wrong (default: console.error) */
  onError?: (err: Error) => void;
  /** BCP-47 language tag, e.g. 'en'. Defaults to the voice app's configured language. */
  language?: string;
  /** Single-character keyboard shortcut to hold for recording, e.g. 'v' */
  hotkey?: string;
  /** Idle state label override (default: 'Speak') */
  label?: string;
}

export interface VoiceWidgetInstance {
  /** Render the mic button into the given container element */
  mount(containerEl: HTMLElement): void;
  /** Remove the widget and clean up all event listeners */
  destroy(): void;
  /** Programmatically start recording */
  startRecording(): void;
  /** Programmatically stop recording and trigger transcription */
  stopRecording(): void;
  /** Current widget state */
  readonly state: 'idle' | 'recording' | 'transcribing' | 'error';
}

export interface VoiceWidgetFactory {
  create(opts: VoiceWidgetOptions): VoiceWidgetInstance;
}

declare const VoiceWidget: VoiceWidgetFactory;
export default VoiceWidget;

// CommonJS / UMD
export { VoiceWidget };
