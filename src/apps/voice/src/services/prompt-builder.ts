/**
 * Builds a vocabulary-biasing prompt for Whisper transcription.
 * Whisper uses the prompt as context to bias recognition toward specific terms.
 * Respects ~224 token limit (~800 chars as conservative estimate).
 */

import { configStore } from "./config-store.js";

const MAX_PROMPT_CHARS = 800;

// Core developer terminology — terms Whisper commonly misrecognizes
const BUILTIN_TERMS = [
  // Cloud & Infrastructure
  "AWS", "Azure", "GCP", "Kubernetes", "Docker", "Terraform", "Ansible",
  "EKS", "ECS", "Fargate", "Lambda", "S3", "EC2", "CloudFront", "VPC",
  // Languages & Runtimes
  "TypeScript", "JavaScript", "Node.js", "Python", "Rust", "Go", "Golang",
  "C++", "C#", "Kotlin", "Swift", "Ruby", "PHP", "Deno", "Bun",
  // Frameworks
  "React", "Vue", "Angular", "Next.js", "Nuxt", "Svelte", "Express",
  "FastAPI", "Django", "Flask", "Spring Boot", "NestJS", "Remix",
  // Databases
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "SQLite", "DynamoDB",
  "Cassandra", "Elasticsearch", "Prisma", "Drizzle",
  // DevOps & Tools
  "GitHub", "GitLab", "CI/CD", "Jenkins", "CircleCI", "Nginx", "Apache",
  "Grafana", "Prometheus", "Datadog", "Sentry", "Webpack", "Vite",
  "ESLint", "Prettier", "Turborepo", "pnpm", "npm", "yarn",
  // APIs & Protocols
  "REST", "GraphQL", "gRPC", "WebSocket", "OAuth", "JWT", "CORS",
  "API", "SDK", "CLI", "MCP", "SSE",
  // AI/ML
  "OpenAI", "Anthropic", "Claude", "GPT", "Whisper", "LLM", "RAG",
  "embeddings", "fine-tuning", "transformer",
  // General Dev
  "DevOps", "SRE", "microservice", "monorepo", "refactor", "middleware",
  "endpoint", "deployment", "rollback", "hotfix", "linting",
];

let _vocabularyFetcher: (() => Promise<string[]>) | null = null;

/**
 * Register an external vocabulary source (e.g. DevGlide vocabulary store).
 */
export function setVocabularyFetcher(
  fetcher: () => Promise<string[]>
): void {
  _vocabularyFetcher = fetcher;
}

/**
 * Build a prompt string for Whisper vocabulary biasing.
 * Priority: custom terms > vocabulary store > built-in terms.
 */
export async function buildVocabPrompt(): Promise<string | undefined> {
  const cfg = configStore.get();
  if (!cfg.vocabBiasing) return undefined;

  const parts: string[] = [];
  let charCount = 0;

  // 1. Custom user terms (highest priority)
  const customTerms = cfg.customVocabulary ?? [];
  for (const term of customTerms) {
    const t = term.trim();
    if (!t) continue;
    if (charCount + t.length + 2 > MAX_PROMPT_CHARS) break;
    parts.push(t);
    charCount += t.length + 2; // account for ", " separator
  }

  // 2. DevGlide vocabulary store terms
  if (_vocabularyFetcher && charCount < MAX_PROMPT_CHARS) {
    try {
      const vocabTerms = await _vocabularyFetcher();
      for (const term of vocabTerms) {
        const t = term.trim();
        if (!t) continue;
        if (charCount + t.length + 2 > MAX_PROMPT_CHARS) break;
        if (!parts.includes(t)) {
          parts.push(t);
          charCount += t.length + 2;
        }
      }
    } catch {
      // vocabulary store unavailable — skip
    }
  }

  // 3. Built-in dev terms (fill remaining space)
  if (charCount < MAX_PROMPT_CHARS) {
    for (const term of BUILTIN_TERMS) {
      if (charCount + term.length + 2 > MAX_PROMPT_CHARS) break;
      if (!parts.includes(term)) {
        parts.push(term);
        charCount += term.length + 2;
      }
    }
  }

  if (parts.length === 0) return undefined;
  return parts.join(", ");
}
