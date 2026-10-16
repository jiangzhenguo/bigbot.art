/**
 * 回归:ask.user 脏记录不得进 recall(2026-09-27 真实事故)
 *
 * 现象:用户看到 Agent「调用失败」。实际是旧版本 worker 的 ask.user 没被拦截
 * (模型把 options 序列化成 JSON 字符串且被截断 → normalizeAskOptions 解析失败),
 * 调用落到工具桥报「未知工具:ask.user」,又被 index.ts 原样写进 recall:
 *   content    = `ask.user({"question":...`(JSON.stringify 截断到 120 字符)
 *   toolResult = `未知工具:ask.user`
 * 渲染层恢复历史时,该记录因 options 非数组而降级成一条裸文本气泡,
 * 内容就是那串 `ask.user({...`,看起来像一次失败的调用。
 *
 * 修复(三处,本文件锁住其中两处的可观测行为):
 *   1. pi-chat.ts — options 不足 2 个时把 ask.user 从本轮 calls 摘掉,绝不交给工具桥
 *   2. index.ts  — 写 recall 的工具循环跳过 name==='ask.user' 的条目(提问卡由 result.ask 分支记)
 *   3. restore-msgs.ts — 恢复历史时,question 可用的降级为纯文本提问,否则整条丢弃
 *      (原在 useAgentChat.ts;多会话后抽到共享恢复函数)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

/** 读源文件(测试直接断言源码契约,避免起 worker 子进程的成本) */
function src(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

describe('ask.user 脏记录防护', () => {
  it('index.ts 写 recall 的工具循环跳过 ask.user(提问卡只由 result.ask 分支记录)', () => {
    const code = src('apps/desktop/src/main/index.ts');
    // 必须存在显式跳过,且跳过的判定就是 'ask.user'
    expect(code).toMatch(/if \(tc\.name === 'ask\.user'\) continue;/);
    // 跳过必须发生在 addRecall 之前(在 for 循环体内、addRecall 调用之前出现)
    const loopStart = code.indexOf('for (const tc of result.toolCalls) {');
    expect(loopStart).toBeGreaterThan(-1);
    const skipIdx = code.indexOf("if (tc.name === 'ask.user') continue;", loopStart);
    // 2026-10-10 起对话执行体抽为 executeAgentChat(opts),recall 写入的标识符随之改为 opts.projectId
    const addRecallIdx = code.indexOf('memory.addRecall(opts.projectId, {', loopStart);
    expect(skipIdx).toBeGreaterThan(loopStart);
    expect(addRecallIdx).toBeGreaterThan(skipIdx);
  });

  it('pi-chat.ts 在 options 不足时把 ask.user 从 calls 摘掉,不让它落到工具桥', () => {
    const code = src('packages/agent/src/pi-chat.ts');
    expect(code).toMatch(/calls\.splice\(idx, 1\)/);
    // 摘除后必须处理「本轮只剩它」的情况,否则会继续走工具桥报未知工具
    expect(code).toMatch(/if \(calls\.length === 0\) \{/);
    // 兜底回复不能让用户看到空消息
    expect(code).toMatch(/return \{ reply: t \|\| question/);
  });

  it('restore-msgs.ts 恢复历史时不再把脏记录渲染成裸文本气泡', () => {
    const code = src('apps/desktop/src/renderer/src/pages/agent/restore-msgs.ts');
    // 降级分支必须用 args.question 而不是 r.content(后者就是那串 ask.user({...)
    expect(code).toMatch(/text: args\.question/);
    expect(code).not.toMatch(/kind: 'agent', text: r\.content \}/);
    // 没有 question 的脏记录直接丢弃
    expect(code).toMatch(/continue;/);
    // useAgentChat 必须走共享恢复函数,避免两套逻辑分叉
    const hook = src('apps/desktop/src/renderer/src/pages/agent/useAgentChat.ts');
    expect(hook).toMatch(/restoreMsgsFromRecall/);
  });

  it('真实事故记录的形状:options 被截断成非法 JSON 时应被判定为不可点选', () => {
    // 复刻当时 recall 里的原始字段
    const dirtyOptions =
      '[{"label": "image-edit（I2V 图生视频）", "sub": "指令+输入图逐场景生成真人，最贴合「保持';
    let opts: unknown = dirtyOptions;
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts);
      } catch {
        opts = null;
      }
    }
    expect(Array.isArray(opts)).toBe(false);

    // 与 useAgentChat.ts 恢复分支同口径:不满足 → 不能渲染成可点选卡片
    const question = '动漫转真人，保持动作不变、去掉字幕。选哪种方案？';
    const canRenderAsk = Boolean(question && Array.isArray(opts) && opts.length >= 2);
    expect(canRenderAsk).toBe(false);
  });
});
