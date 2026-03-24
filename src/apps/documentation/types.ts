// ── Content types ─────────────────────────────────────────────────────────────

export interface ToolGuide {
  id: string;
  type: 'tool-guide';
  toolName: string;
  summary: string;
  executionModel: string;
  prerequisites: string[];
  inputsExplained: Record<string, string>;
  resultSemantics: Record<string, string>;
  preferredPatterns: string[];
  antiPatterns: string[];
  followUpChecks: string[];
  commonFailures: string[];
  seeAlso: string[];
  tags: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocWorkflow {
  id: string;
  type: 'workflow';
  name: string;
  goal: string;
  toolsInvolved: string[];
  preflight: string[];
  stepSequence: string[];
  successCriteria: string[];
  failureBranches: string[];
  expectedOutputs: string[];
  expectedNoise: string[];
  tags: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocExample {
  id: string;
  type: 'example';
  toolName: string;
  scenario: string;
  startingAssumptions: string[];
  toolSequence: string[];
  whatGoodLooksLike: string[];
  whatBadLooksLike: string[];
  whatToDoNext: string[];
  tags: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Troubleshooting {
  id: string;
  type: 'troubleshooting';
  toolName: string;
  symptom: string;
  likelyCauses: string[];
  howToDiagnose: string[];
  howToFix: string[];
  whenToRetry: string;
  tags: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectOverride {
  id: string;
  type: 'project-override';
  targetToolName: string;
  overrides: Record<string, unknown>;
  notes: string;
  tags: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Union and summary types ──────────────────────────────────────────────────

export type DocEntry = ToolGuide | DocWorkflow | DocExample | Troubleshooting | ProjectOverride;

export type DocType = DocEntry['type'];

export interface DocSummary {
  id: string;
  type: DocType;
  /** Primary label: toolName, name, or scenario depending on type */
  title: string;
  summary: string;
  tags: string[];
  scope: 'project' | 'global';
  updatedAt: string;
}
