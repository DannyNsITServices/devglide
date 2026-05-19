import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, LlmConfig } from '../../types.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const llmExecutor: ExecutorFunction = async (
  config: NodeConfig,
  _context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as LlmConfig;

  try {
    let prompt: string;

    if (cfg.promptSource === 'file') {
      if (!cfg.promptFile) {
        return { status: 'failed', error: 'promptFile is required when promptSource is file' };
      }
      const base = _context.project?.path ?? process.cwd();
      const filePath = path.resolve(base, cfg.promptFile.replace(/^\/+/, ''));
      if (!filePath.startsWith(base + path.sep) && filePath !== base) {
        return { status: 'failed', error: 'Path traversal denied' };
      }
      prompt = await fs.readFile(filePath, 'utf-8');
    } else {
      if (!cfg.prompt) {
        return { status: 'failed', error: 'prompt is required when promptSource is inline' };
      }
      prompt = cfg.prompt;
    }

    const client = new OpenAI();
    const response = await client.chat.completions.create({
      model: cfg.model ?? 'gpt-4o-mini',
      temperature: cfg.temperature ?? 0.7,
      max_tokens: cfg.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0]?.message?.content ?? '';
    return { status: 'passed', output: content };
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
  }
};
