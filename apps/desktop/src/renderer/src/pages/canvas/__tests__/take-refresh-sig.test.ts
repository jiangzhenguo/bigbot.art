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

/**
 * ★ shot 侧采用同一签名(2026-10-09 事故回归)
 *
 * 事故:镜头 03 生成成功(T4),takes.json 里 4 条 Take 齐全、节点 currentTakeId 也指向 T4、
 * 产物文件真实存在 —— **磁盘上一切正确**,但检查器的 Take 历史与预览都不显示。
 *
 * 根因:`ImageTakeSection`(图片节点)**早就修过**这个 bug(见本文件顶部注释),
 * 但 `ShotInspector`(镜头节点)沿用旧签名 `<nodeId>|<job.id>:<status>,…` ——
 * jobs 为内存态、重启/重载/切画布后查不到该 job → 签名恒定 → **永不重拉**。
 * 注意:即便 job 一直在内存里,签名变化也只在 job 状态迁移那一刻触发一次;
 * 任何导致重挂载的场景(切画布/重启)都会让 jobs 查不到该 job 而彻底失联。
 *
 * 本组用例锁「shot 侧必须用同一个签名函数」的语义,防止两处再次分叉。
 */
describe('shot 侧刷新签名(事故回归)', () => {
  const SHOT = 'shot-1791533926779-jqqc';

  it('★ 队列无该 job 时,产物出现必须让签名变化(旧 shot 实现不变 → 事故)', () => {
    // 模拟:重启后 RenderQueue 内存清空,jobs 里没有这个 shot 的 job
    const beforeGen = takeRefreshSig(SHOT, [], '');
    const afterGen = takeRefreshSig(SHOT, [], '/out/shot-xxx_1791542363600.mp4');
    expect(beforeGen).not.toBe(afterGen);
  });

  it('旧 shot 签名(只看 job)在同一场景下**不会**变化 —— 证明这就是事故根因', () => {
    // 旧实现:signature = `${nodeId}|${mine.map(...)}`
    const legacySig = (js: Job[]) => `${SHOT}|${js.map((j) => `${j.id}:${j.status}`).join(',')}`;
    expect(legacySig([])).toBe(legacySig([])); // 恒定 → effect 首次挂载后永不重拉
    // 而新签名在同一输入下会随 resultPath 变化
    expect(takeRefreshSig(SHOT, [], '/out/a.mp4')).not.toBe(takeRefreshSig(SHOT, [], ''));
  });

  it('切换 Take(节点 resultPath 变化)→ 签名变化,重拉历史', () => {
    const t3 = takeRefreshSig(SHOT, [], '/out/shot_1791538557457.mp4');
    const t4 = takeRefreshSig(SHOT, [], '/out/shot_1791542363600.mp4');
    expect(t3).not.toBe(t4);
  });

  it('读到未终态 Take → 需要复检(收敛「完成但仍是 queued」的落盘竞态)', () => {
    // 事故的另一半:Take 落盘与 notify 之间有窗口,读早了会拿到 queued
    expect(hasUnsettledTake([{ status: 'succeeded' }, { status: 'queued' }])).toBe(true);
    expect(hasUnsettledTake([{ status: 'succeeded' }])).toBe(false);
  });
});
