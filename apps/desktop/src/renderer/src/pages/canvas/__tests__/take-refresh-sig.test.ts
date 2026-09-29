/**
 * Take 历史刷新签名单测 —— 「图片生成成功后 chip 停在排队中」事故回归。
 *
 * 事故形态(2026-09-29,真实):image-gen 节点生成成功、磁盘上 Take 已是 `succeeded`,
 * 但检查器里那条 chip 一直显示「排队中」,必须用户手动点一下(触发重渲染)才刷新。
 *
 * 根因:`ImageTakeSection` 的刷新签名只含 `job.id:status`,而 `RenderQueue` 的 jobs 是
 * **纯内存**的 —— 应用重启 / 窗口重载 / 切画布再回来之后队列里没有这条 job,签名恒为
 * `<nodeId>|`,effect 首次挂载拉一次后就**永不重拉**;再加上「恰好在 patch 落盘前读盘」
 * 的竞态没有任何主动重试,界面就永久定格在错误状态。
 *
 * 修法两条(本测试各锁一条):
 *  1. `takeRefreshSig` 把节点产物路径纳入签名 —— 产物出现即强信号,与 job 是否存在无关
 *  2. `hasUnsettledTake` 识别未终态记录,供调用方做一次短延时复检(收敛落盘竞态)
 */
import { describe, expect, it } from 'vitest';
import { takeRefreshSig, hasUnsettledTake } from '../inspector/ImageTakeSection';

const NODE = 'image-gen-1';
type Job = { nodeId: string; id: string; status: string };
const job = (id: string, status: string, nodeId = NODE): Job => ({ nodeId, id, status });

describe('takeRefreshSig', () => {
  it('job 状态变化 → 签名变化(提交完成要重拉)', () => {
    const queued = takeRefreshSig(NODE, [job('j1', 'queued')], '');
    const done = takeRefreshSig(NODE, [job('j1', 'succeeded')], '');
    expect(queued).not.toBe(done);
  });

  it('★事故回归:队列里没有该 job 时,产物出现也必须让签名变化', () => {
    // 场景:重启 / 窗口重载后 RenderQueue 内存清空,jobs 里根本没有这条 job。
    // 旧实现两个签名完全相同 → 永不重拉 → chip 永远显示「排队中」。
    const before = takeRefreshSig(NODE, [], '');
    const after = takeRefreshSig(NODE, [], '/out/images/a.png');
    expect(before).not.toBe(after);
  });

  it('产物路径变化(切 Take / Agent 回写)也触发重拉', () => {
    const a = takeRefreshSig(NODE, [], '/out/images/a.png');
    const b = takeRefreshSig(NODE, [], '/out/images/b.png');
    expect(a).not.toBe(b);
  });

  it('完全无关的节点 job 不参与本节点签名(不误触发)', () => {
    const other = takeRefreshSig(NODE, [job('j9', 'running', 'other-node')], '');
    const none = takeRefreshSig(NODE, [], '');
    expect(other).toBe(none);
  });

  it('签名稳定:同输入同输出(避免 effect 抖动反复请求)', () => {
    const jobs = [job('j1', 'running'), job('j2', 'queued')];
    expect(takeRefreshSig(NODE, jobs, '/x.png')).toBe(takeRefreshSig(NODE, jobs, '/x.png'));
  });

  it('resultPath 非字符串(undefined/null/数字)按空串处理,不产生 "undefined" 噪音', () => {
    const base = takeRefreshSig(NODE, [], '');
    expect(takeRefreshSig(NODE, [], undefined)).toBe(base);
    expect(takeRefreshSig(NODE, [], null)).toBe(base);
    expect(takeRefreshSig(NODE, [], 42)).toBe(base);
  });
});

describe('hasUnsettledTake', () => {
  it('有 queued / running 记录 → true(需要复检)', () => {
    expect(hasUnsettledTake([{ status: 'queued' }])).toBe(true);
    expect(hasUnsettledTake([{ status: 'succeeded' }, { status: 'running' }])).toBe(true);
  });

  it('全部已终态 → false(不额外请求)', () => {
    expect(hasUnsettledTake([{ status: 'succeeded' }, { status: 'failed' }, { status: 'cancelled' }])).toBe(false);
  });

  it('空 / 缺省 → false(不炸)', () => {
    expect(hasUnsettledTake([])).toBe(false);
    expect(hasUnsettledTake(undefined)).toBe(false);
  });
});
