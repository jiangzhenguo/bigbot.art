/**
 * 布尔字段归一化单测(2026-10-09 「人物绑定不上角色卡」事故)
 *
 * 事故链(决定性证据来自画布数据):
 *   1. Agent 调 `canvas.update_node` 时把布尔写成了**字符串**:
 *      `{"nodeId":"shot-…","data":{"mode":"ref-image","modeOverride":"true"}}`
 *   2. 渲染层所有判定都是**严格比较** `data.modeOverride === true` ——
 *      字符串 `"true" === true` 为 **false**,于是「用户已手动选过模式,别再自动推导」
 *      这道闸**失效**。
 *   3. 模式与参考派生态被入边推导接管,提交时参考图丢失 →
 *      用户看到「人物根本没绑定上角色卡,和角色卡差距很大」。
 *
 * 这类 bug 的特点:**完全静默** —— 工具返回 ✓、节点上确实写着 `"true"`、
 * 界面看着也是开的,只有严格比较的那一行知道它是假的。
 *
 * 修法:在**写入端**归一化(update_node / create_node),而不是把十几处
 * `=== true` 逐个放宽 —— 放宽比较还会把真正的非布尔垃圾值也放进来。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-boolnorm-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-bool';
const CANVAS = 'c-bool';
const SHOT_ID = 'shot-bool-1';

let M: typeof import('../tool-handlers.js');

function makeStore(initialData: Record<string, unknown> = {}) {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: [
      { id: SHOT_ID, kind: 'shot', label: '镜头 03', position: { x: 0, y: 0 }, data: { prompt: 'x', ...initialData } },
    ],
    edges: [],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: () => ({ ok: true }),
    __snapshot: snapshot,
  } as unknown as import('../store.js').ProjectStore & { __snapshot: typeof snapshot };
}

function makeHandlers(store: import('../store.js').ProjectStore) {
  return new M.ToolHandlers(store, {} as never, {} as never, {} as never, {} as never, {} as never, {});
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

beforeAll(async () => {
  M = await import('../tool-handlers.js');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('normalizeBooleanFields — 纯函数', () => {
  it('字符串 "true"/"false" → 真布尔(事故原样)', () => {
    // 事故里 Agent 传的正是这个形态
    const r = M.normalizeBooleanFields({ mode: 'ref-image', modeOverride: 'true' });
    expect(r.modeOverride).toBe(true);
    expect(r.modeOverride === true).toBe(true); // 严格比较必须成立
  });

  it('各种真值写法都能识别', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 1, true]) {
      expect(M.normalizeBooleanFields({ modeOverride: v }).modeOverride, String(v)).toBe(true);
    }
  });

  it('各种假值写法都能识别', () => {
    for (const v of ['false', 'FALSE', ' false ', '0', 'no', 0, false]) {
      expect(M.normalizeBooleanFields({ modeOverride: v }).modeOverride, String(v)).toBe(false);
    }
  });

  it('布尔本身原样通过(不误改)', () => {
    expect(M.normalizeBooleanFields({ modeOverride: true }).modeOverride).toBe(true);
    expect(M.normalizeBooleanFields({ modeOverride: false }).modeOverride).toBe(false);
  });

  it('不认识的值**保持原样**,不瞎猜', () => {
    const r = M.normalizeBooleanFields({ modeOverride: 'maybe' });
    expect(r.modeOverride).toBe('maybe');
  });

  it('未出现的字段不被凭空造出来', () => {
    const r = M.normalizeBooleanFields({ prompt: 'x' });
    expect('modeOverride' in r).toBe(false);
    expect('specOverride' in r).toBe(false);
  });

  it('不修改入参(纯函数)', () => {
    const input = { modeOverride: 'true' };
    M.normalizeBooleanFields(input);
    expect(input.modeOverride).toBe('true'); // 原对象没被改
  });

  it('一次处理多个布尔字段', () => {
    const r = M.normalizeBooleanFields({
      modeOverride: 'true',
      specOverride: 'false',
      manualOrder: 1,
      refVideoSilent: 'no',
    });
    expect(r.modeOverride).toBe(true);
    expect(r.specOverride).toBe(false);
    expect(r.manualOrder).toBe(true);
    expect(r.refVideoSilent).toBe(false);
  });
});

describe('canvas.update_node — 写入端归一化(事故回归)', () => {
  it('Agent 传 "true" 字符串 → 落到节点上是真布尔', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call(
      'canvas.update_node',
      { nodeId: SHOT_ID, data: { mode: 'ref-image', modeOverride: 'true' } },
      ctx,
    );
    expect(res.ok).toBe(true);
    const data = (store.__snapshot.nodes[0] as { data: Record<string, unknown> }).data;
    // 关键:严格比较必须成立,否则「手动模式」闸失效 → 参考图被推导顶掉
    expect(data.modeOverride).toBe(true);
    expect(data.modeOverride === true).toBe(true);
  });

  it('写 "true" 之后回读校验通过(不会被当成未生效)', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call(
      'canvas.update_node',
      { nodeId: SHOT_ID, data: { modeOverride: 'true' } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.result).not.toContain('未生效');
  });

  it('真布尔照常写入', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    await h.call('canvas.update_node', { nodeId: SHOT_ID, data: { modeOverride: true } }, ctx);
    const data = (store.__snapshot.nodes[0] as { data: Record<string, unknown> }).data;
    expect(data.modeOverride).toBe(true);
  });
});

describe('canvas.create_node — 同样归一化', () => {
  it('建 shot 时传 "true" → 落盘为真布尔', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call(
      'canvas.create_node',
      { kind: 'shot', label: '新镜头', data: { mode: 'ref-image', modeOverride: 'true', width: 1024, height: 576 } },
      ctx,
    );
    expect(res.ok).toBe(true);
    const created = store.__snapshot.nodes.find(
      (n) => (n as { label?: string }).label === '新镜头',
    ) as { data: Record<string, unknown> } | undefined;
    expect(created?.data.modeOverride).toBe(true);
  });
});
