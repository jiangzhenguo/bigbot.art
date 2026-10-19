import { describe, expect, it, beforeEach } from 'vitest';
import {
  estimateTokens,
  foldRecallSummary,
  historyRoom,
  isMinimaxM3,
  packByTokens,
  planContext,
  placementOf,
  readLmStudioContext,
  readOllamaContext,
  tailKeepCount,
} from '../context-budget.js';

describe('planContext', () => {
  beforeEach(() => {
    delete process.env.BIGBOTART_AGENT_CONTEXT_WINDOW;
  });
  it('本地用已加载窗口,工作集是输入预算的 60%', () => {
    const plan = planContext({ placement: 'local', model: 'ornith', loadedContextTokens: 262_144 });
    expect(plan.windowTokens).toBe(262_144);
    expect(plan.inputBudget).toBe(262_144 - 32_000);
    expect(plan.compactAt).toBe(Math.floor(plan.inputBudget * 0.6));
  });

  it('探不到本地长度时用 32k 保守窗口', () => {
    const plan = planContext({ placement: 'local', model: 'unknown' });
    expect(plan.windowTokens).toBe(32_768);
    expect(plan.compactAt).toBeLessThan(plan.windowTokens);
  });

  it('云端 MiniMax-M3 窗口 100 万,压缩线停在 48 万', () => {
    const plan = planContext({ placement: 'cloud', model: 'MiniMax-M3' });
    expect(plan.windowTokens).toBe(1_000_000);
    expect(plan.compactAt).toBe(480_000);
  });

  it('云端 MiniMax-M2 用 20.48 万,不套 M3 的 48 万线', () => {
    const plan = planContext({ placement: 'cloud', model: 'MiniMax-M2.7' });
    expect(plan.windowTokens).toBe(204_800);
    expect(plan.compactAt).toBeLessThan(204_800);
    expect(isMinimaxM3('MiniMax-M2.7')).toBe(false);
  });

  it('未知云端模型用 12.8 万', () => {
    const plan = planContext({ placement: 'cloud', model: 'deepseek-chat' });
    expect(plan.windowTokens).toBe(128_000);
  });

  it('回环上的 OpenAI 兼容端点算本地', () => {
    expect(placementOf({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1' })).toBe('local');
    expect(placementOf({ kind: 'openai-compatible', baseUrl: 'https://api.minimax.io/v1' })).toBe('cloud');
    expect(placementOf({ kind: 'lmstudio' })).toBe('local');
    expect(placementOf({ kind: 'cloud', provider: 'minimax' })).toBe('cloud');
  });
});

describe('历史按 token 装入', () => {
  it('中文比英文更贵', () => {
    expect(estimateTokens('你好世界')).toBeGreaterThan(estimateTokens('hello'));
  });

  it('从最新往回装,超预算的旧消息丢掉,最新一条始终留下', () => {
    const items = [
      { content: '旧指令'.repeat(400) },
      { content: '中间' },
      { content: '最新' },
    ];
    const packed = packByTokens(items, 30);
    expect(packed.map((x) => x.content)).toEqual(['中间', '最新']);
    expect(packByTokens([{ content: '超长'.repeat(500) }], 10)).toHaveLength(1);
  });

  it('系统提示占掉预算后,历史至少还留 2000 token', () => {
    expect(historyRoom(100_000, 10_000)).toBe(90_000);
    expect(historyRoom(3_000, 10_000)).toBe(2_000);
  });

  it('尾部保留到 token 预算,工具记录不占额度', () => {
    const entries = [
      { role: 'user', content: '旧'.repeat(300) },
      { role: 'tool', content: 'canvas.list_nodes({})' },
      { role: 'assistant', content: '新回复' },
    ];
    const n = tailKeepCount(entries, 20, 1);
    expect(n).toBe(2);
    expect(entries.slice(-n).some((e) => e.role === 'tool')).toBe(true);
  });

  it('自动摘要带固定抬头,并截断单行', () => {
    const text = foldRecallSummary([{ role: 'user', content: '画一张猫'.repeat(80), toolName: undefined }]);
    expect(text.startsWith('【对话自动摘要】')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4_000);
  });
});

describe('运行时上下文长度解析', () => {
  it('认 LM Studio 已加载实例上的 context_length', () => {
    const n = readLmStudioContext(
      {
        data: [
          {
            id: 'ornith',
            loaded_instances: [{ config: { context_length: 262144 } }],
          },
        ],
      },
      'ornith',
    );
    expect(n).toBe(262144);
  });

  it('认 Ollama model_info 里的 *.context_length', () => {
    expect(readOllamaContext({ model_info: { 'qwen2.context_length': 32768 } })).toBe(32768);
  });
});
