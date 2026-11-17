import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { DEFAULT_AI_CONFIG, classifyAiError, originPattern, testConnection, validateBaseUrl } from '../src/lib/ai';
import { createStore, type Area, type AiPort } from '../src/lib/store';
import type { AiConfig, AiTestResult } from '../src/lib/types';

const cfg: AiConfig = { ...DEFAULT_AI_CONFIG, model: 'gpt-test' };
const apiErr = (statusCode: number, message: string) =>
  new APICallError({ message, url: 'http://127.0.0.1:3425/v1/chat/completions', requestBodyValues: {}, statusCode, isRetryable: false });
const okModel = () => new MockLanguageModelV3({
  doGenerate: {
    content: [{ type: 'text', text: 'OK' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
    warnings: [],
  },
});
const failingModel = (err: unknown) => new MockLanguageModelV3({ doGenerate: async () => { throw err; } });

describe('validateBaseUrl', () => {
  it('accepts http and https addresses and trims them', () => {
    expect(validateBaseUrl('  http://127.0.0.1:3425/v1 ')).toBe('http://127.0.0.1:3425/v1');
    expect(validateBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });
  it('rejects empty text, non-URLs and other schemes', () => {
    for (const s of ['', 'not a url', 'ftp://x.com/v1', 'javascript:alert(1)']) expect(() => validateBaseUrl(s)).toThrow();
  });
});

describe('originPattern', () => {
  it('grants the whole origin, not just the path the user typed', () => {
    expect(originPattern('http://127.0.0.1:3425/v1')).toBe('http://127.0.0.1:3425/*');
  });
});

describe('classifyAiError', () => {
  it('401 and 403 mean the key is wrong', () => {
    expect(classifyAiError(apiErr(401, 'Unauthorized')).reason).toBe('key');
    expect(classifyAiError(apiErr(403, 'Forbidden')).reason).toBe('key');
  });
  it('404 that names the model means the model is wrong', () => {
    expect(classifyAiError(apiErr(404, 'The model `nope` does not exist')).reason).toBe('model');
  });
  it('400 or 422 that names the model means the model is wrong', () => {
    expect(classifyAiError(apiErr(400, 'Invalid model: gpt-x')).reason).toBe('model');
    expect(classifyAiError(apiErr(422, 'model not supported')).reason).toBe('model');
  });
  it('rate limits and server errors that mention a model are not model-name problems', () => {
    expect(classifyAiError(apiErr(429, 'rate limit exceeded for model gpt-4o-mini')).reason).toBe('unknown');
    expect(classifyAiError(apiErr(503, 'no upstream available for model X')).reason).toBe('unknown');
  });
  it('404 that does not name the model means the path is wrong', () => {
    expect(classifyAiError(apiErr(404, 'Not Found')).reason).toBe('address');
  });
  it('a network failure means the address cannot be reached', () => {
    expect(classifyAiError(new TypeError('fetch failed')).reason).toBe('address');
  });
  it('a timeout is reported as a timeout', () => {
    const e = new Error('The operation timed out.'); e.name = 'TimeoutError';
    expect(classifyAiError(e).reason).toBe('timeout');
  });
  it('anything else is unknown and keeps its message', () => {
    const r = classifyAiError(new Error('boom'));
    expect(r.reason).toBe('unknown');
    expect(r.message).toContain('boom');
  });
});

describe('testConnection', () => {
  it('succeeds when the model answers', async () => {
    expect(await testConnection(cfg, okModel())).toEqual({ ok: true });
  });
  it('reports a wrong key', async () => {
    const r = await testConnection(cfg, failingModel(apiErr(401, 'Unauthorized')));
    expect(r).toMatchObject({ ok: false, reason: 'key' });
  });
  it('reports a wrong model name', async () => {
    const r = await testConnection(cfg, failingModel(apiErr(404, 'The model `gpt-test` does not exist')));
    expect(r).toMatchObject({ ok: false, reason: 'model' });
  });
  it('reports an unreachable address', async () => {
    const r = await testConnection(cfg, failingModel(new TypeError('fetch failed')));
    expect(r).toMatchObject({ ok: false, reason: 'address' });
  });
});

describe('store testAi message', () => {
  const area: Area = { get: async () => ({}), set: async () => {} };
  it('passes the unsaved config to the AI port and returns its result', async () => {
    const seen: AiConfig[] = [];
    const fake: AiPort = {
      test: async (c): Promise<AiTestResult> => { seen.push(c); return { ok: false, reason: 'key', message: 'bad key' }; },
      lookup: async () => ({ ok: false, reason: 'unknown', message: 'unused' }),
      meaning: async () => ({ ok: false, reason: 'unknown', message: 'unused' }),
      judgePhrase: async () => ({ ok: false, reason: 'unknown', message: 'unused' }),
    };
    const store = createStore(area, undefined, fake);
    const r = await store.handle({ type: 'testAi', config: cfg });
    expect(seen).toEqual([cfg]);
    expect(r).toEqual({ ok: false, reason: 'key', message: 'bad key' });
  });
});
