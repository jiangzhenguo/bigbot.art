/**
 * OpenCode Go 套餐的模型/协议矩阵。
 *
 * 背景(2026-10-20):该端点按模型分三套协议 ——
 *  - `/v1/chat/completions`:deepseek / glm / kimi / longcat …
 *  - `/v1/responses`(本 App 已支持):grok-4.6/4.7、gpt-6-luna、muse-spark…
 *  - `/v1/messages`(Anthropic 形状,本 App 未实现):minimax / qwen / claude-haiku
 * 以前的实现只认 chat,于是选到 grok 每轮 400 `ModelProtocolUnsupported`。
 */
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@bigbotart/shared';
import {
  OPENCODE_GO_NON_CHAT_MODELS,
  OPENCODE_GO_RESPONSES_MODELS,
  filterOpenCodeGoModels,
  isOpenCodeGoEndpoint,
  isOpenCodeGoNonChatModel,
  isOpenCodeGoResponsesModel,
  resolveLlmEndpoint,
  resolveModelProtocol,
  sanitizeOpenCodeGoSettings,
  toChatLlm,
} from '../llm.js';

describe('isOpenCodeGoEndpoint', () => {
  it('认 providerId=opencode-go', () => {
    expect(isOpenCodeGoEndpoint({ providerId: 'opencode-go' })).toBe(true);
  });

  it('认 host 含 opencode.ai/zen/go', () => {
    expect(isOpenCodeGoEndpoint({ baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe(true);
    expect(isOpenCodeGoEndpoint({ baseUrl: 'https://opencode.ai/zen/go/v1/' })).toBe(true);
  });

  it('不误伤其他供应商', () => {
    expect(isOpenCodeGoEndpoint({ providerId: 'deepseek' })).toBe(false);
    expect(isOpenCodeGoEndpoint({ baseUrl: 'https://api.deepseek.com/v1' })).toBe(false);
    expect(isOpenCodeGoEndpoint({ baseUrl: 'https://opencode.ai/inference/openai/v1' })).toBe(false);
  });
});

describe('模型协议分类', () => {
  it('responses 模型:grok / gpt-luna / muse(选中它们会自动走 /v1/responses)', () => {
    for (const id of [
      'grok-4.7', 'grok-4.6',
      'gpt-6-luna', 'gpt-5.6-luna',
      'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor',
    ]) {
      expect(OPENCODE_GO_RESPONSES_MODELS.has(id), id).toBe(true);
      expect(isOpenCodeGoResponsesModel(id), id).toBe(true);
      // 「不能按 chat 直接发」= true,但已支持 → 不再被过滤
      expect(isOpenCodeGoNonChatModel(id), id).toBe(true);
      expect(filterOpenCodeGoModels([id]), id).toEqual([id]);
    }
  });

  it('未实现的 /v1/messages 模型:仍被过滤 + 明确拒绝', () => {
    for (const id of [
      'claude-haiku-5-5',
      'minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'minimax-m3.1-flash-free',
      'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-plus',
      'gemini-4-argon-contributor',
    ]) {
      expect(OPENCODE_GO_NON_CHAT_MODELS.has(id), id).toBe(true);
      expect(isOpenCodeGoResponsesModel(id), id).toBe(false);
      expect(filterOpenCodeGoModels([id]), id).toEqual([]);
    }
  });

  it('chat 模型与未知新模型都按 chat 放行', () => {
    for (const id of ['deepseek-v4.1-flash', 'glm-5.3-flash', 'brand-new-model']) {
      expect(isOpenCodeGoNonChatModel(id), id).toBe(false);
      expect(filterOpenCodeGoModels([id]), id).toEqual([id]);
    }
    expect(isOpenCodeGoNonChatModel(undefined)).toBe(false);
    expect(isOpenCodeGoResponsesModel('  GROK-4.6 ')).toBe(true);
  });
});

describe('filterOpenCodeGoModels', () => {
  it('去掉 /v1/messages 模型,保留 chat 与 responses 模型', () => {
    const raw = [
      'kimi-k2.7-code',
      'deepseek-v4-pro',
      'glm-5.3-flash',
      'grok-4.7',
      'gpt-6-luna',
      'minimax-m3',
      'qwen3.8-max',
      'claude-haiku-5-5',
      'muse-spark-1.3-contributor',
      'longcat-2.5-preview-free',
    ];
    expect(filterOpenCodeGoModels(raw)).toEqual([
      'kimi-k2.7-code',
      'deepseek-v4-pro',
      'glm-5.3-flash',
      'grok-4.7',
      'gpt-6-luna',
      'muse-spark-1.3-contributor',
      'longcat-2.5-preview-free',
    ]);
  });

  it('未知新模型默认放行(允许试探)', () => {
    expect(filterOpenCodeGoModels(['brand-new-model', 'beam-free'])).toEqual([
      'brand-new-model',
      'beam-free',
    ]);
  });
});

describe('resolveModelProtocol(协议判定优先级)', () => {
  const oc = { providerId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' };

  it('OpenCode Go 的 responses 模型 → responses', () => {
    expect(resolveModelProtocol(oc, 'grok-4.6')).toBe('responses');
    expect(resolveModelProtocol(oc, 'gpt-6-luna')).toBe('responses');
  });

  it('OpenCode Go 的 chat 模型 → chat', () => {
    expect(resolveModelProtocol(oc, 'deepseek-v4.1-flash')).toBe('chat');
  });

  it('非 OpenCode Go 端点即使模型同名也走 chat', () => {
    expect(resolveModelProtocol({ baseUrl: 'https://api.x.ai/v1' }, 'grok-4.6')).toBe('chat');
  });

  it('供应商级协议优先于知识表', () => {
    expect(resolveModelProtocol({ ...oc, protocol: 'chat' }, 'grok-4.6')).toBe('chat');
  });

  it('单模型覆盖优先于供应商级与知识表', () => {
    expect(
      resolveModelProtocol({ ...oc, protocol: 'responses', modelProtocols: { 'deepseek-v4-pro': 'chat' } }, 'deepseek-v4-pro'),
    ).toBe('chat');
    expect(resolveModelProtocol({ ...oc, modelProtocols: { 'grok-4.6': 'chat' } }, 'grok-4.6')).toBe('chat');
  });

  it('单模型覆盖最具体,压过供应商级协议', () => {
    expect(
      resolveModelProtocol({ ...oc, protocol: 'responses', modelProtocols: { 'grok-4.6': 'chat' } }, 'grok-4.6'),
    ).toBe('chat');
  });
});

/** 存量设置(settings.json)构造助手:只填本组用例关心的字段 */
function makeSettings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    llm: { kind: 'cloud', provider: 'opencode-go', model: 'grok-4.6' } as AppSettings['llm'],
    cloudProviders: [
      {
        id: 'opencode-go',
        name: 'opencode go',
        avatar: 'OC',
        sub: 'OpenCode Go 套餐',
        host: 'https://opencode.ai/zen/go/v1',
        models: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'grok-4.6'],
        enabled: true,
        hasKey: true,
      },
    ],
    ...over,
  } as AppSettings;
}

describe('sanitizeOpenCodeGoSettings(存量设置自愈)', () => {
  it('responses 模型不再被清除(grok-4.6 现在可用)', () => {
    const { next, fixes } = sanitizeOpenCodeGoSettings(makeSettings());
    expect(next.cloudProviders![0]!.models).toEqual(['deepseek-v4.1-flash', 'glm-5.3-flash', 'grok-4.6']);
    expect((next.llm as { model?: string }).model).toBe('grok-4.6');
    expect(fixes).toEqual([]);
  });

  it('清掉未实现协议(/v1/messages)的模型,并把失效的选中模型切到首个可用模型', () => {
    const s = makeSettings();
    s.cloudProviders![0]!.models = ['deepseek-v4.1-flash', 'minimax-m3', 'claude-haiku-5-5'];
    s.llm = { kind: 'cloud', provider: 'opencode-go', model: 'minimax-m3' } as AppSettings['llm'];
    const { next, fixes } = sanitizeOpenCodeGoSettings(s);
    expect(next.cloudProviders![0]!.models).toEqual(['deepseek-v4.1-flash']);
    expect((next.llm as { model?: string }).model).toBe('deepseek-v4.1-flash');
    expect(fixes.join('\n')).toContain('minimax-m3');
    expect(fixes.join('\n')).toContain('已切换到「deepseek-v4.1-flash」');
  });

  it('选中模型本来可用时只清列表、不动选择', () => {
    const s = makeSettings();
    s.cloudProviders![0]!.models = ['glm-5.3-flash', 'minimax-m3'];
    s.llm = { kind: 'cloud', provider: 'opencode-go', model: 'glm-5.3-flash' } as AppSettings['llm'];
    const { next, fixes } = sanitizeOpenCodeGoSettings(s);
    expect((next.llm as { model?: string }).model).toBe('glm-5.3-flash');
    expect(next.cloudProviders![0]!.models).not.toContain('minimax-m3');
    expect(fixes.some((f) => f.includes('已切换到'))).toBe(false);
  });

  it('不误伤其他供应商的同名模型', () => {
    const s = makeSettings({
      cloudProviders: [
        {
          id: 'grok',
          name: 'Grok（xAI）',
          avatar: 'G',
          sub: 'grok-4.7 / 4.6 / 4.5',
          host: 'https://api.x.ai/v1',
          models: ['grok-4.7', 'grok-4.6'],
          enabled: true,
          hasKey: true,
        },
      ],
    } as Partial<AppSettings>);
    const { next, fixes } = sanitizeOpenCodeGoSettings(s);
    expect(next.cloudProviders![0]!.models).toEqual(['grok-4.7', 'grok-4.6']);
    expect(fixes).toEqual([]);
  });

  it('列表全是未实现协议的模型时保留原列表(不清空用户配置,交给提交期报错)', () => {
    const s = makeSettings();
    s.cloudProviders![0]!.models = ['minimax-m3'];
    const { next } = sanitizeOpenCodeGoSettings(s);
    expect(next.cloudProviders![0]!.models).toEqual(['minimax-m3']);
  });

  it('没有云端供应商时原样返回', () => {
    const s = makeSettings({ cloudProviders: undefined } as Partial<AppSettings>);
    const { next, fixes } = sanitizeOpenCodeGoSettings(s);
    expect(next).toBe(s);
    expect(fixes).toEqual([]);
  });
});

describe('resolveLlmEndpoint / toChatLlm', () => {
  it('未实现协议的模型在取 Key 之前就被明确拒绝', async () => {
    const s = makeSettings();
    s.llm = { kind: 'cloud', provider: 'opencode-go', model: 'minimax-m3' } as AppSettings['llm'];
    await expect(resolveLlmEndpoint(s, undefined)).rejects.toThrow(
      /只提供 \/v1\/messages.*deepseek-v4\.1-flash/s,
    );
  });

  it('非 OpenCode Go 端点的同名模型不被协议闸误伤', async () => {
    const s = makeSettings({
      llm: { kind: 'cloud', provider: 'grok', model: 'grok-4.6' } as AppSettings['llm'],
      cloudProviders: [
        {
          id: 'grok',
          name: 'Grok（xAI）',
          avatar: 'G',
          sub: 'grok-4.7 / 4.6 / 4.5',
          host: 'https://api.x.ai/v1',
          models: ['grok-4.6'],
          enabled: true,
          hasKey: true,
        },
      ],
    } as Partial<AppSettings>);
    const err = await resolveLlmEndpoint(s, undefined).catch((e: Error) => e);
    expect(String(err)).not.toContain('/v1/messages');
  });

  it('toChatLlm 把协议一路带到 worker(漏带 = 悄悄退回 chat)', () => {
    expect(
      toChatLlm({ baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'grok-4.6', label: 'x', protocol: 'responses' }),
    ).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      model: 'grok-4.6',
      protocol: 'responses',
    });
  });
});
