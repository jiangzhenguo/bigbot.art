/**
 * 项目封面的 Store 落盘往返测试
 *
 * ⚠️ **为什么单独一个文件**:`ProjectStore` 的 `PROJECTS_FILE` 在**模块加载时**
 * 就按 `BIGBOTART_HOME` 求值。如果在用例里(模块已加载后)才改 env,写入的仍是
 * 真实 `~/.bigbotart/projects.json` —— 实测踩中过:两条本该进临时目录的测试项目
 * 直接写进了开发者真实数据(红线上「测试绝不污染用户数据」)。
 * 因此这里必须在**任何 import 之前**设 env,并且用动态 import 拿被测模块。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bba-cover-store-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

let ProjectStore: typeof import('../store').ProjectStore;

beforeAll(async () => {
  ({ ProjectStore } = await import('../store'));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('ProjectStore 封面字段往返(真实写盘,隔离在临时目录)', () => {
  it('写入后确实落在临时目录,而不是真实 ~/.bigbotart', () => {
    const st = new ProjectStore();
    st.createProject('隔离验证');
    expect(existsSync(join(tmpHome, 'projects.json'))).toBe(true);
  });

  it('setProjectCover 写盘 → 新实例重读仍在(证明确实持久化)', () => {
    const st = new ProjectStore();
    const p = st.createProject('封面项目');
    const ok = st.setProjectCover(p.id, { coverMode: 'manual', coverAssetId: 'asset-x' });
    expect(ok.ok).toBe(true);

    const raw = JSON.parse(readFileSync(join(tmpHome, 'projects.json'), 'utf-8')) as {
      projects: Array<{ id: string; coverMode?: string; coverAssetId?: string }>;
    };
    const saved = raw.projects.find((x) => x.id === p.id)!;
    expect(saved.coverMode).toBe('manual');
    expect(saved.coverAssetId).toBe('asset-x');

    // 新实例从磁盘重读
    const st2 = new ProjectStore();
    expect(st2.getProject(p.id)?.coverMode).toBe('manual');
    expect(st2.getProject(p.id)?.coverAssetId).toBe('asset-x');

    // 清除 → 回自动,assetId 一并清掉(不留自相矛盾状态)
    expect(st2.setProjectCover(p.id, { coverMode: 'auto', coverAssetId: null }).ok).toBe(true);
    const p2 = new ProjectStore().getProject(p.id)!;
    expect(p2.coverMode).toBe('auto');
    expect(p2.coverAssetId).toBeUndefined();
  });

  it('mode=manual 但缺 assetId → 明确拒绝,且不写脏状态', () => {
    const st = new ProjectStore();
    const p = st.createProject('脏状态防护');
    const r = st.setProjectCover(p.id, { coverMode: 'manual', coverAssetId: null });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('assetId');
    expect(new ProjectStore().getProject(p.id)?.coverMode).toBeUndefined();
  });

  it('项目不存在 → 拒绝', () => {
    const st = new ProjectStore();
    expect(st.setProjectCover('proj-nope', { coverMode: 'auto', coverAssetId: null }).ok).toBe(false);
  });
});
