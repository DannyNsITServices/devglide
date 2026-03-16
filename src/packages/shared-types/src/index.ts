export interface LogEntry {
  type: string;
  session: string;
  seq: number;
  ts: string;
  url?: string;
  ua?: string;
  message?: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  targetPath: string;
}

export interface TriggerCommand {
  command: string;
  selector?: string;
  text?: string;
  value?: string;
  timeout?: number;
  ms?: number;
  clear?: boolean;
  contains?: boolean;
  path?: string;
}

export interface TriggerScenario {
  id?: string;
  name: string;
  description?: string;
  steps: TriggerCommand[];
  target: string;
  createdAt?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}
