/**
 * 工具结果文本组装单测 — 覆盖 pi-chat.ts 的 `buildToolResultText`。
 *
 * 真实事故(2026-09-28,项目 proj-1790491667525-ee3x5):
 *   用户指令「反推提示词」,模型新建节点后**拿不到 nodeId**(结构化字段被丢弃,只喂了 result
 *   文本),于是用 `人物参考图-1790509845606-00a2` 这类「标题-id」拼出来的幻觉 id 调
 *   canvas.get_node → 404;再调 assets.list 翻 47 项资产找真 id。整轮 11 轮 / 18 次工具调用,
 *   其中只有 4 次真正干活,耗时 249 秒。
 *
 * 本测试锁定修复语义:成功的工具若返回了 nodeId,它必须出现在喂给模型的文本里。
 */
import { describe, it, expect } from 'vitest';
import { buildToolResultText } from '../pi-chat.js';

describe('buildToolResultText — nodeId 必须回传给模型', () => {
  it('成功且有 nodeId → 正文里带上 id,并提示别用标题拼', () => {
    const out = buildToolResultText('已建节点「人物参考图」', 'asset-1790509845606-009t', true);
    expect(out).toContain('已建节点「人物参考图」'); // 原摘要保留
    expect(out).toContain('asset-1790509845606-009t'); // 关键:id 可见
    expect(out).toContain('不要用标题拼 id'); // 反幻觉提示
  });

  it('无 nodeId → 原样返回(不凭空加字段)', () => {
    const out = buildToolResultText('当前画布 6 个节点', undefined, true);
    expect(out).toBe('当前画布 6 个节点');
    expect(out).not.toContain('节点 id =');
  });

  it('失败 → 即使带 nodeId 也不拼(失败时 id 不可信)', () => {
    const out = buildToolResultText('节点 xxx 不存在', 'ghost-node', false);
    expect(out).toBe('节点 xxx 不存在');
    expect(out).not.toContain('[节点 id =');
  });

  it('ok 缺省视为成功(向后兼容)', () => {
    const out = buildToolResultText('已建节点「A」', 'n-1');
    expect(out).toContain('[节点 id = n-1]');
  });

  it('空 nodeId 字符串等同无 id', () => {
    const out = buildToolResultText('已建节点「A」', '', true);
    expect(out).toBe('已建节点「A」');
  });
});
