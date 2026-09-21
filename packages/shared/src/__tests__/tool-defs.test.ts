/**
 * 工具定义测试 — document.read(分段读文档)与既有关键工具存在性
 */
import { describe, it, expect } from 'vitest';
import { toolDefinitions } from '../tool-defs.js';

const names = toolDefinitions().map((t) => t.name);

describe('document.read 工具定义', () => {
  it('存在于工具清单', () => {
    expect(names).toContain('document.read');
  });

  it('schema:nodeId 必填,chunk/size 可选数字', () => {
    const t = toolDefinitions().find((x) => x.name === 'document.read')!;
    const p = t.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(p.required).toContain('nodeId');
    expect((p.properties.nodeId as { type: string }).type).toBe('string');
    expect((p.properties.chunk as { type: string }).type).toBe('number');
    expect((p.properties.size as { type: string }).type).toBe('number');
    expect(t.description).toContain('分段');
  });

  it('描述提示先读 chunk=0 看结构(与实现一致)', () => {
    const t = toolDefinitions().find((x) => x.name === 'document.read')!;
    expect(t.description).toContain('chunk=0');
  });
});

describe('工具清单完整性', () => {
  it('关键既有工具仍在(未被覆盖/删除)', () => {
    for (const n of ['canvas.list_nodes', 'canvas.get_node', 'canvas.connect', 'storyboard.plan', 'engine.submit', 'assets.import', 'memory.remember', 'continuity.check', 'ask.user']) {
      expect(names).toContain(n);
    }
  });

  it('工具名唯一', () => {
    expect(new Set(names).size).toBe(names.length);
  });
});