import fs from 'fs/promises';
import OpenAI from 'openai';
import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, LlmConfig } from '../../types.js';
import { safePath } from './file-executor.js';

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
      // safePath realpath-resolves — a symlink inside the project pointing
      // outside it (e.g. at ~/.ssh) must not be readable as a prompt; the
      // lexical prefix check alone does not catch that.
      const filePath = await safePath(cfg.promptFile, base);
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
