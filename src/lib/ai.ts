import { APICallError, Output, generateText, type LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import type { AiConfig, AiFailure, AiLookupResult, AiTestResult } from './types';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3425/v1';
export const DEFAULT_AI_CONFIG: AiConfig = { baseUrl: DEFAULT_BASE_URL, apiKey: '', model: '', language: 'zh-CN' };
export const AI_TIMEOUT_MS = 30_000;

/** Returns the trimmed address without a trailing slash. Throws if it is not an http(s) URL. */
export function validateBaseUrl(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new Error('地址不是合法的 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('地址必须以 http:// 或 https:// 开头');
  return s.replace(/\/+$/, '');
}

/** Host permission pattern for the origin of a gateway address. */
export function originPattern(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`;
}

/** Maps a failed request to the reason the options page shows. */
export function classifyAiError(err: unknown): { reason: AiFailure; message: string } {
  const e = err as { name?: string; message?: string };
  const message = e?.message ?? String(err);
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { reason: 'timeout', message: '请求超时（30 秒）' };
  if (err instanceof APICallError) {
    const code = err.statusCode;
    if (code === 401 || code === 403) return { reason: 'key', message: 'key 无效或没有权限' };
    const mentionsModel = /model/i.test(message) || /model/i.test(err.responseBody ?? '');
    // Only client errors point at the model name; 429 and 5xx often mention the model too.
    if (mentionsModel && (code === 400 || code === 404 || code === 422)) return { reason: 'model', message: `模型不可用：${message}` };
    if (code === 404) return { reason: 'address', message: '地址不对（接口路径不存在）' };
    return { reason: 'unknown', message };
  }
  if (err instanceof TypeError) return { reason: 'address', message: '无法连接到该地址，请检查地址，或重新保存配置以授权访问' };
  return { reason: 'unknown', message };
}

export function createLanguageModel(config: AiConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'word-catcher',
    baseURL: config.baseUrl,
    apiKey: config.apiKey || undefined,
  });
  return provider.chatModel(config.model);
}

/**
 * Sends a one-token request to check the address, key and model.
 * Retries are off so each failure maps to one reason.
 */
export async function testConnection(config: AiConfig, model?: LanguageModel): Promise<AiTestResult> {
  try {
    await generateText({
      model: model ?? createLanguageModel(config),
      prompt: 'Reply with OK.',
      maxOutputTokens: 8,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, ...classifyAiError(err) };
  }
}

const LookupSchema = z.object({
  definitions: z.array(z.string()),
  collocations: z.array(z.string()),
  phrases: z.array(z.string()),
  examples: z.array(z.object({ en: z.string(), translation: z.string() })),
});

const LANGUAGE_NAMES: Record<string, string> = { 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', en: 'English' };

/**
 * Asks the model for the definitions, collocations, phrases and example sentences of one word.
 * Only the word is sent. The page address and the surrounding sentence are not.
 */
export async function lookupWord(config: AiConfig, word: string, model?: LanguageModel): Promise<AiLookupResult> {
  const language = LANGUAGE_NAMES[config.language] ?? LANGUAGE_NAMES['zh-CN'];
  try {
    const { output } = await generateText({
      model: model ?? createLanguageModel(config),
      output: Output.object({ schema: LookupSchema }),
      system: `You are an English dictionary. Explain the word the user gives you. Write definitions and example translations in ${language}. Keep each item short.`,
      prompt: word,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    return { ok: true, lookup: { ...output, generatedAt: new Date().toISOString() } };
  } catch (err) {
    return { ok: false, ...classifyAiError(err) };
  }
}
