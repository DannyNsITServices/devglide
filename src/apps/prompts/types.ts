export interface Prompt {
  id: string;
  title: string;
  content: string;           // Supports {{varName}} placeholders
  description?: string;
  category?: string;
  tags: string[];
  variables?: string[];      // Auto-detected from {{...}} in content
  model?: string;            // Preferred model hint
  temperature?: number;      // Preferred temperature hint
  rating?: number;           // 1–5
  notes?: string;            // Evaluation notes
  projectId?: string;        // undefined = global
  createdAt: string;
  updatedAt: string;
}

export interface PromptSummary {
  id: string;
  title: string;
  description?: string;
  category?: string;
  tags: string[];
  rating?: number;
  scope: 'project' | 'global';
  updatedAt: string;
}
