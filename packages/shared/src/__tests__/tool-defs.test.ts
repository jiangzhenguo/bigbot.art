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
    for (const n of ['canvas.list_nodes', 'canvas.get_node', 'canvas.connect', 'storyboard.plan', 'engine.submit', 'assets.import', 'memory.remember', 'continuity.check', 'ask.user', 'todo.write', 'plan.present']) {
      expect(names).toContain(n);
    }
  });

  it('skills 域双形态工具齐全(read/activate/deactivate 新增)', () => {
    for (const n of ['skills.list', 'skills.read', 'skills.activate', 'skills.deactivate', 'skills.apply', 'skills.save']) {
      expect(names).toContain(n);
    }
  });

  it('skills.activate 必填 skillId,描述说明画布级激活', () => {
    const t = toolDefinitions().find((x) => x.name === 'skills.activate')!;
    const p = t.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(p.required).toContain('skillId');
    expect(t.description).toContain('激活');
  });

  it('skills.save 支持 instructions/inject(指令段保存)', () => {
    const t = toolDefinitions().find((x) => x.name === 'skills.save')!;
    const p = t.parameters as { properties: Record<string, unknown> };
    expect(p.properties.instructions).toBeDefined();
    expect(p.properties.inject).toBeDefined();
  });

  it('工具名唯一', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('h3.write_prompt 是镜头提示词入口,update_node 声明 shot 会被拒绝', () => {
    expect(names).toContain('h3.write_prompt');
    const write = toolDefinitions().find((t) => t.name === 'h3.write_prompt')!;
    const params = write.parameters as { required?: string[] };
    expect(params.required).toContain('nodeId');
    expect(write.description).toContain('Ref2VA');
    expect(write.description).toContain('不提交生成');
    const update = toolDefinitions().find((t) => t.name === 'canvas.update_node')!;
    expect(update.description).toContain('h3.write_prompt');
    const create = toolDefinitions().find((t) => t.name === 'canvas.create_node')!;
    expect(create.description).toContain('shot 不要写 prompt');
    expect(create.description).toContain('通常省略');
    const createParams = create.parameters as { properties: Record<string, { description?: string; type?: string }> };
    expect(createParams.properties.x?.description).toContain('通常省略');
    expect(createParams.properties.y?.description).toContain('通常省略');
    expect(createParams.properties.place?.type).toBe('object');
    const list = toolDefinitions().find((t) => t.name === 'canvas.list_nodes')!;
    expect(list.description).toContain('画布坐标');
    expect(list.description).toContain('卡片宽高');
    const tidy = toolDefinitions().find((t) => t.name === 'canvas.tidy')!;
    expect(tidy.description).toContain('只改坐标');
    const tidyParams = tidy.parameters as { properties: Record<string, { type?: string }>; required?: string[] };
    expect(tidyParams.properties.scope?.type).toBe('string');
    expect(tidyParams.required ?? []).not.toContain('scope');
  });

  it('web.search / web.fetch_image 在清单里,且名字不含短横线', () => {
    expect(names).toContain('web.search');
    expect(names).toContain('web.fetch_image');
    const search = toolDefinitions().find((t) => t.name === 'web.search')!;
    const fetchImg = toolDefinitions().find((t) => t.name === 'web.fetch_image')!;
    const searchParams = search.parameters as { required?: string[] };
    const fetchParams = fetchImg.parameters as { required?: string[] };
    expect(searchParams.required).toContain('query');
    expect(fetchParams.required).toContain('url');
    expect(search.description).toContain('只进对话');
    expect(fetchImg.description).toContain('不下载视频');
  });
});