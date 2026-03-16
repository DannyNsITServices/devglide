export interface VocabularyEntry {
  id: string;
  term: string;
  definition: string;
  aliases?: string[];
  category?: string;
  tags: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VocabularyEntrySummary {
  id: string;
  term: string;
  definition: string;
  aliases?: string[];
  category?: string;
  tags: string[];
  scope: 'project' | 'global';
  updatedAt: string;
}
