/**
 * 未实现节点「入口下架」回归单测(2026-10-08)
 *
 * 背景:精简画布节点时发现 18 类 kind 里有 4 类是「画得出来、点不动」的空壳 ——
 *   `director`(导演台,只存 prompt)、`workflow-input` / `workflow-output`
 *   (派生态齐全但没有「运行整个工作流」的实现)、以及冒充 ComfyUI 入口的那一项
 *   (面板文案写「ComfyUI 工作流 · 导入 workflow_api.json」,kind 其实是 `director`,
 *   点了只弹一个导演 prompt 输入框 —— 零 ComfyUI 代码)。
 *
 * 处置 = **隐藏入口**(不是删定义):老画布里的这些节点要照常打开、照常渲染,
 * 下架的只是**新建入口**。本文件锁死三件事:
 *   1. 渲染层面板(`NODE_TYPES`)不再列出隐藏节点 —— UI 面板/「+」弹层唯一来源;
 *   2. Agent 的节点清单(`nodeKindGuide`)/ 连接器摘要(`connectorSummary`)
 *      不再宣传隐藏节点(否则模型照着清单去建,必被拒绝,白烧一轮往返);
 *   3. Agent 真的去建(`canvas.create_node`)时**明确拒绝并给替代方案**,
 *      而不是静默建出一个空壳 —— 这是本次修复的承重点:面板隐藏挡不住 Agent。
 */
import { describe, it, expect } from 'vitest';
import {
  HIDDEN_NODE_KINDS,
  HIDDEN_NODE_REASONS,
  isHiddenNodeKind,
  nodeKindGuide,
  connectorSummary,
} from '@bigbotart/shared';

/** 与渲染层 constants.ts 的 NODE_TYPES 同源(此处只取 kind/name,避免引入 React 组件图) */
import { NODE_TYPES, isHiddenKind } from '../../renderer/src/pages/canvas/constants';

describe('HIDDEN_NODE_KINDS · 清单本身', () => {
  it('恰好下架 director / workflow-input / workflow-output 三类', () => {
    expect([...HIDDEN_NODE_KINDS].sort()).toEqual(['director', 'workflow-input', 'workflow-output']);
  });

  it('每一类都带「为什么不能建」的人话原因(拒绝创建时要用)', () => {
    for (const k of HIDDEN_NODE_KINDS) {
      expect(HIDDEN_NODE_REASONS[k], `${k} 缺下架原因`).toBeTruthy();
    }
  });

  it('isHiddenNodeKind 判定正确,且对空值不为真', () => {
    expect(isHiddenNodeKind('director')).toBe(true);
    expect(isHiddenNodeKind('workflow-output')).toBe(true);
    expect(isHiddenNodeKind('shot')).toBe(false);
    expect(isHiddenNodeKind(undefined)).toBe(false);
    expect(isHiddenNodeKind('')).toBe(false);
  });
});

describe('节点面板(NODE_TYPES)· 隐藏节点不再可见', () => {
  it('面板的 kind 不含任何隐藏节点', () => {
    for (const t of NODE_TYPES) {
      expect(isHiddenKind(t.kind), `${t.name}(${t.kind})仍在面板里`).toBe(false);
    }
  });

  it('原先那几个空壳条目(含冒充 ComfyUI 的那项)全部下架', () => {
    const names = NODE_TYPES.map((t) => t.name);
    expect(names).not.toContain('导演台');
    expect(names).not.toContain('ComfyUI 工作流'); // 面板曾用它冒充 ComfyUI,kind 实为 director
    expect(names).not.toContain('工作流入口');
    expect(names).not.toContain('工作流出口');
  });

  it('面板条目不再带 P1 / WF 角标字段(角标已整体移除)', () => {
    // 2026-10-08:P1 是遗留的优先级标记、WF 随 workflow-* 下架而无对应节点,
    // 两个角标都失去信息量 → 连同 NodeTag 的 p1/wf 字段一并移除。
    // 这里锁死字段不回潮:回潮会让面板重新出现无意义的角标文字。
    for (const t of NODE_TYPES) {
      expect(t, `${t.name} 又带上了 p1/wf 字段`).not.toHaveProperty('p1');
      expect(t, `${t.name} 又带上了 p1/wf 字段`).not.toHaveProperty('wf');
    }
  });

  it('已实现的节点一个都没被误伤', () => {
    const kinds = NODE_TYPES.map((t) => t.kind);
    for (const k of [
      'document', 'storyboard', 'asset', 'image-gen', 'image-edit', 'image-upscale',
      'video-upscale', 'image-crop', 'image-stitch', 'image-split', 'frame-grab',
      'shot', 'audio-ref', 'timeline',
    ]) {
      expect(kinds, `${k} 被误删`).toContain(k);
    }
  });
});

describe('Agent 认知面 · 不再宣传隐藏节点', () => {
  it('nodeKindGuide 不列出隐藏节点(否则模型照着清单建、必被拒)', () => {
    const guide = nodeKindGuide();
    for (const k of HIDDEN_NODE_KINDS) {
      expect(guide).not.toContain(`- ${k}:`);
    }
  });

  it('nodeKindGuide 仍完整保留已实现节点', () => {
    const guide = nodeKindGuide();
    for (const k of ['shot', 'image-gen', 'frame-grab', 'video-upscale', 'timeline', 'audio-ref']) {
      expect(guide).toContain(`- ${k}:`);
    }
  });

  it('connectorSummary 不再出现已下架的源节点', () => {
    const summary = connectorSummary();
    expect(summary).not.toContain('- director:可连');
    expect(summary).not.toContain('- workflow-input:可连');
    // 收口行也不该再宣传 director
    expect(summary).not.toMatch(/收口到 wf-output:.*director/);
  });

  it('connectorSummary 仍保留已实现节点的完整端口说明', () => {
    const summary = connectorSummary();
    for (const k of ['shot', 'image-gen', 'image-edit', 'audio-ref', 'asset']) {
      expect(summary).toContain(`- ${k}:可连`);
    }
  });
});

/* ─────────────── Agent 真去建时必须被拒绝(本次修复的承重点) ─────────────── */

describe('canvas.create_node · 隐藏节点拒绝创建', () => {
  /**
   * 只造 `canvas.create_node` 路径上用得到的依赖:
   * 拒绝发生在**读画布之前**,所以 store 给一个会抛错的桩也照样通过 ——
   * 这本身就是断言的一部分(不该为了拒绝而先去动用户数据)。
   */
  const makeHandlers = async () => {
    const { ToolHandlers } = await import('../tool-handlers.js');
    const boom = () => {
      throw new Error('不该触达:隐藏节点的拒绝必须在读画布之前完成');
    };
    return new ToolHandlers(
      { loadProjectCanvases: boom, saveCanvasSnapshot: boom } as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  };
  const ctx = { projectId: 'p', canvasId: 'c' };

  it.each([...HIDDEN_NODE_KINDS])('%s → 明确失败,且给出可执行替代方案', async (kind) => {
    const h = await makeHandlers();
    const res = await h.call('canvas.create_node', { kind, label: 'x' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain(kind);
    expect(res.result).toContain('尚未实现'); // 说清「为什么」
    expect(res.result).toContain('shot'); // 给替代节点,别让模型原地打转
  });

  it('拦截是「按 kind 精确」的,不会把所有创建都挡掉', async () => {
    const h = await makeHandlers();
    // document 不在隐藏清单 → 会继续走到读画布那步,撞上我们埋的错并被 call() 兜成失败结果。
    // 关键是**失败原因不是「尚未实现」** —— 证明拦截只针对隐藏清单,没有误伤已实现节点。
    const res = await h.call('canvas.create_node', { kind: 'document' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).not.toContain('尚未实现');
  });
});

