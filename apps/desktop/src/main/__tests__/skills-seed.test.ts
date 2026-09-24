/**
 * SkillStore 内置技能种子合并 + tombstone 单测(主进程 skills.ts)
 * - 空库首次构造:seed 全部内置技能
 * - 已有库再次构造:合并官方新增的内置 id(按 id 去重),不动用户技能
 * - 内置技能被 delete → 记 tombstone,重新构造不复活
 *
 * 关键:skills.ts 的 DATA_DIR 在 import 时按 BIGBOTART_HOME 求值 →
 * 模块顶层先设临时目录,再在 beforeAll 里动态 import(绝不触碰真实 ~/.bigbotart)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-skills-test-'));
process.env.BIGBOTART_HOME = tmpHome;

const SKILLS_FILE = join(tmpHome, 'skills.json');
const TOMBSTONE_FILE = join(tmpHome, 'skills-builtin-deleted.json');

let M: typeof import('../skills.js');

beforeAll(async () => {
  M = await import('../skills.js');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('SkillStore 内置技能种子', () => {
  it('空库首次构造 → seed 全部内置技能(builtin:true)', () => {
    const store = new M.SkillStore();
    const builtins = store.list().filter((s) => s.builtin);
    expect(builtins.length).toBeGreaterThanOrEqual(3); // 至少原有 3 个出厂技能
    expect(builtins.some((s) => s.id === 'paper-collage')).toBe(true);
    expect(existsSync(SKILLS_FILE)).toBe(true);
  });

  it('已有库再次构造 → 合并不存在的内置 id,用户技能原样保留', () => {
    // 模拟老版本库:只剩一个用户技能 + 一个内置技能(其余内置被"官方扩容"新增)
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: 'skill-user-1',
          name: '我的技能',
          nodes: [],
          edges: [],
          params: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'paper-collage',
          name: '纸拼贴剧情片',
          nodes: [],
          edges: [],
          params: [],
          instructions: '旧内容不被覆盖',
          builtin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    const list = store.list();
    // 用户技能保留
    expect(list.some((s) => s.id === 'skill-user-1')).toBe(true);
    // 缺失的内置技能被合并进来
    expect(list.some((s) => s.id === 'ecom-product' && s.builtin)).toBe(true);
    // 已存在的内置技能内容不被种子覆盖
    expect(store.get('paper-collage')?.instructions).toBe('旧内容不被覆盖');
  });

  it('删除内置技能 → 记 tombstone,重新构造不复活;删用户技能不记', () => {
    const store = new M.SkillStore();
    expect(store.delete('ecom-product').ok).toBe(true);
    expect(store.delete('skill-user-1').ok).toBe(true);
    const tombstones = JSON.parse(readFileSync(TOMBSTONE_FILE, 'utf-8')) as string[];
    expect(tombstones).toContain('ecom-product');
    expect(tombstones).not.toContain('skill-user-1');

    const store2 = new M.SkillStore();
    expect(store2.get('ecom-product')).toBeUndefined(); // tombstone 挡住复活
    expect(store2.get('paper-collage')).toBeDefined(); // 未删的内置仍在
  });

  it('全部删空后重新构造 → 内置技能全部 tombstone,不复活任何一个', () => {
    const store = new M.SkillStore();
    for (const s of store.list()) store.delete(s.id);
    const store2 = new M.SkillStore();
    const ids = store2.list().map((s) => s.id);
    expect(ids).toHaveLength(0); // 所有内置均被用户删过(tombstone),空库也不再复活
    expect(ids).not.toContain('ecom-product');
  });
});
