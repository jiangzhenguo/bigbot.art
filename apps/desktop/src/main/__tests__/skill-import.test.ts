import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSkillPackage, parseSkillDocument, skillDraftsFromPackage } from '../skill-import';

describe('parseSkillDocument', () => {
  it('读 frontmatter,正文当操作指令', () => {
    const res = parseSkillDocument(
      `---
name: 纸拼贴
desc: 用纸拼贴讲一个短故事
params: 主题, 时长
inject: summary
---

## 任务流程
先 {主题} 再出图
`,
      'fallback',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.name).toBe('纸拼贴');
    expect(res.draft.description).toBe('用纸拼贴讲一个短故事');
    expect(res.draft.inject).toBe('summary');
    expect(res.draft.params).toEqual(['{主题}', '{时长}']);
    expect(res.draft.instructions).toContain('任务流程');
    expect(res.draft.nodes).toEqual([]);
  });

  it('没有 frontmatter 时用文件名当技能名', () => {
    const res = parseSkillDocument('## 任务流程\n直接做', '我的广告');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.name).toBe('我的广告');
    expect(res.draft.inject).toBe('full');
    expect(res.draft.instructions).toContain('直接做');
  });

  it('空文件拒绝', () => {
    expect(parseSkillDocument('   ', 'x')).toEqual({ ok: false, error: '文件是空的' });
  });

  it('单个技能 JSON 可带画布模板', () => {
    const res = parseSkillDocument(
      JSON.stringify({ name: '电商', instructions: '先问素材', nodes: [{ id: 'n1' }], edges: [] }),
      'x',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.name).toBe('电商');
    expect(res.draft.nodes).toEqual([{ id: 'n1' }]);
  });

  it('技能库整表拒绝', () => {
    const res = parseSkillDocument('[{"name":"a"}]', 'skills');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('单个技能');
  });
});

describe('skillDraftsFromPackage', () => {
  it('根目录的 SKILL.md 就是这一份技能', () => {
    const res = skillDraftsFromPackage(
      [{ rel: 'SKILL.md', text: '---\nname: 纸拼贴\n---\n先出分镜' }],
      'paper',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.drafts.map((d) => d.name)).toEqual(['纸拼贴']);
  });

  it('zip 常见的单层包装目录会被剥掉', () => {
    const res = skillDraftsFromPackage(
      [{ rel: 'my-skill/SKILL.md', text: '按文件名当技能名' }],
      'my-skill.zip',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.drafts.map((d) => d.name)).toEqual(['my-skill']);
  });

  it('根目录没有入口时,每个带 SKILL.md 的子文件夹各算一个技能', () => {
    const res = skillDraftsFromPackage(
      [
        { rel: 'a/SKILL.md', text: '---\nname: 甲\n---\n甲的流程' },
        { rel: 'b/skill.json', text: JSON.stringify({ name: '乙', instructions: '乙的流程' }) },
        { rel: '__MACOSX/a/._SKILL.md', text: 'junk' },
      ],
      'pack',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.drafts.map((d) => d.name).sort()).toEqual(['乙', '甲']);
  });

  it('没有技能入口时说明该放什么', () => {
    const res = skillDraftsFromPackage([{ rel: 'notes/readme.txt', text: '只是笔记' }], 'x');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('SKILL.md');
  });
});

describe('loadSkillPackage', () => {
  it('文件夹和 zip 都能读到同一份 SKILL.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bba-skill-'));
    const zip = join(root, 'pack.zip');
    try {
      writeFileSync(join(root, 'SKILL.md'), '---\nname: 文件夹技能\n---\n从文件夹来');
      const packed = spawnSync('zip', ['-q', zip, 'SKILL.md'], { cwd: root });
      const dirRes = await loadSkillPackage(root);
      expect(dirRes.ok).toBe(true);
      if (!dirRes.ok) return;
      expect(dirRes.drafts[0]?.name).toBe('文件夹技能');
      if (packed.status !== 0) return;
      const zipRes = await loadSkillPackage(zip);
      expect(zipRes.ok).toBe(true);
      if (!zipRes.ok) return;
      expect(zipRes.drafts[0]?.name).toBe('文件夹技能');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
