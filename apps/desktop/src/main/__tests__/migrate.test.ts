/**
 * 数据迁移测试 — 平铺文件 → workspaces/<pid>/ 子目录收敛(2026-09-29)
 *
 * 这是**数据安全关键路径**:迁移器写错会丢用户画布/记忆/Take。
 * 因此这里锁死四条不变量:
 *   1. 无损   —— 旧文件内容原样出现在新位置(逐字节比对)
 *   2. 幂等   —— 重复调用不再动任何文件
 *   3. 有备份 —— 被移动的文件在备份目录留有副本(回滚依据)
 *   4. 不吞错 —— 目标已存在时拒绝覆盖并记入 failures,而不是静默丢弃
 *
 * 另锁两条边界:
 *   - 孤立 pid(磁盘有 canvases-<pid>.json 但 projects.json 无该记录)也必须迁移,不丢文件
 *   - `.bak` / `.demo-bak-*` 等历史快照后缀一律不碰
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDataMigration, collectLegacyProjectIds } from '../migrate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bbart-migrate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 铺一个"迁移前"的平铺数据目录 */
function seedFlat(projectIds: string[]): void {
  writeFileSync(
    join(dir, 'projects.json'),
    JSON.stringify({ projects: projectIds.map((id) => ({ id, name: `项目 ${id}`, canvasIds: [], activeCanvasId: 'main' })) }, null, 2),
  );
  for (const pid of projectIds) {
    writeFileSync(join(dir, `canvases-${pid}.json`), JSON.stringify({ projectId: pid, canvases: [{ id: 'main', nodes: [], edges: [] }], activeCanvasId: 'main' }));
    writeFileSync(join(dir, `memory-${pid}.json`), JSON.stringify({ projectId: pid, core: {}, canvasMemory: {}, recall: [], archival: [] }));
    writeFileSync(join(dir, `takes-${pid}.json`), JSON.stringify({ takes: [{ id: `t-${pid}` }] }));
  }
}

describe('collectLegacyProjectIds · 只认精确形态的旧文件名', () => {
  it('提取三种前缀的 pid', () => {
    writeFileSync(join(dir, 'canvases-p1.json'), '{}');
    writeFileSync(join(dir, 'memory-p2.json'), '{}');
    writeFileSync(join(dir, 'takes-p3.json'), '{}');
    expect(collectLegacyProjectIds(dir)).toEqual(['p1', 'p2', 'p3']);
  });

  it('带历史快照后缀的一律不认(.bak / .demo-bak-* / .pre-rescue-*)', () => {
    writeFileSync(join(dir, 'canvases-p1.json'), '{}');
    writeFileSync(join(dir, 'canvases-p1.json.bak'), '{}');
    writeFileSync(join(dir, 'canvases-p2.json.demo-bak-1789522062660'), '{}');
    writeFileSync(join(dir, 'canvases-p3.json.pre-rescue-1790064088714'), '{}');
    expect(collectLegacyProjectIds(dir)).toEqual(['p1']);
  });

  it('目录不存在时返回空数组(不抛)', () => {
    expect(collectLegacyProjectIds(join(dir, 'nope'))).toEqual([]);
  });
});

describe('runDataMigration · 基本搬运', () => {
  it('把三类文件搬到 workspaces/<pid>/ 下,内容逐字节一致', () => {
    seedFlat(['proj-a']);
    const before = readFileSync(join(dir, 'canvases-proj-a.json'), 'utf-8');

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    expect(r.ran).toBe(true);
    expect(r.movedFiles).toBe(3);
    expect(r.projectsHandled).toBe(1);
    expect(r.failures).toEqual([]);

    expect(existsSync(join(dir, 'workspaces', 'proj-a', 'canvases.json'))).toBe(true);
    expect(existsSync(join(dir, 'workspaces', 'proj-a', 'memory.json'))).toBe(true);
    expect(existsSync(join(dir, 'workspaces', 'proj-a', 'takes.json'))).toBe(true);
    expect(readFileSync(join(dir, 'workspaces', 'proj-a', 'canvases.json'), 'utf-8')).toBe(before);

    // 旧文件已移走(rename,不是复制)
    expect(existsSync(join(dir, 'canvases-proj-a.json'))).toBe(false);
    expect(existsSync(join(dir, 'memory-proj-a.json'))).toBe(false);
    expect(existsSync(join(dir, 'takes-proj-a.json'))).toBe(false);
  });

  it('原文件与 projects.json 本身都不删(只移画布类文件)', () => {
    seedFlat(['proj-a']);
    runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    expect(existsSync(join(dir, 'projects.json'))).toBe(true);
  });

  it('缺 memory/takes 的项目也能迁移(只搬存在的)', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'proj-a' }] }));
    writeFileSync(join(dir, 'canvases-proj-a.json'), '{"canvases":[]}');

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    expect(r.movedFiles).toBe(1);
    expect(existsSync(join(dir, 'workspaces', 'proj-a', 'canvases.json'))).toBe(true);
    expect(existsSync(join(dir, 'workspaces', 'proj-a', 'memory.json'))).toBe(false);
  });

  it('一个旧文件都没有的项目不建空目录', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'empty-proj' }] }));
    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    expect(existsSync(join(dir, 'workspaces', 'empty-proj'))).toBe(false);
    expect(r.projectsHandled).toBe(0);
  });
});

describe('runDataMigration · 孤立 pid(已删除项目遗留的文件)', () => {
  it('磁盘上有、projects.json 里没有的 pid 也要迁移 —— 不丢文件', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'alive' }] }));
    writeFileSync(join(dir, 'canvases-alive.json'), '{"a":1}');
    // 孤立:项目记录已删,文件还在(实测本机 6 个项目对 20+ 画布文件)
    writeFileSync(join(dir, 'canvases-ghost.json'), '{"g":1}');
    writeFileSync(join(dir, 'memory-ghost.json'), '{"g":2}');
    // 中文名的手工产物也不能丢
    writeFileSync(join(dir, 'memory-多画布测试.json'), '{"cn":1}');

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    expect(existsSync(join(dir, 'workspaces', 'ghost', 'canvases.json'))).toBe(true);
    expect(existsSync(join(dir, 'workspaces', 'ghost', 'memory.json'))).toBe(true);
    expect(existsSync(join(dir, 'workspaces', '多画布测试', 'memory.json'))).toBe(true);
    expect(r.projectsHandled).toBe(3);
  });
});

describe('runDataMigration · 幂等', () => {
  it('第二次调用直接跳过,不再动文件', () => {
    seedFlat(['proj-a']);
    runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    const snap1 = readdirSync(join(dir, 'workspaces', 'proj-a')).sort();

    const r2 = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T01:00:00Z') });

    expect(r2.ran).toBe(false);
    expect(r2.skipped).toBeTruthy();
    expect(r2.movedFiles).toBe(0);
    expect(readdirSync(join(dir, 'workspaces', 'proj-a')).sort()).toEqual(snap1);
  });

  it('标记文件已存在时跳过', () => {
    seedFlat(['proj-a']);
    writeFileSync(join(dir, '.migration-ws-v1.json'), '{"migratedAt":"x"}');
    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    expect(r.ran).toBe(false);
    expect(existsSync(join(dir, 'workspaces'))).toBe(false);
  });
});

describe('runDataMigration · 备份与失败处理', () => {
  it('被移动的文件在备份目录留有副本', () => {
    seedFlat(['proj-a']);
    const original = readFileSync(join(dir, 'canvases-proj-a.json'), 'utf-8');

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    expect(r.backupDir).toBeTruthy();
    const bak = join(r.backupDir!, 'proj-a.canvases.json');
    expect(existsSync(bak)).toBe(true);
    expect(readFileSync(bak, 'utf-8')).toBe(original); // 回滚依据
  });

  it('目标已存在时拒绝覆盖并记 failures(不静默丢弃)', () => {
    seedFlat(['proj-a']);
    // 模拟上次迁移半途中断:新位置已有文件
    mkdirSync(join(dir, 'workspaces', 'proj-a'), { recursive: true });
    writeFileSync(join(dir, 'workspaces', 'proj-a', 'canvases.json'), '{"existing":true}');

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    expect(r.failures.some((f) => f.projectId === 'proj-a' && f.error.includes('拒绝覆盖'))).toBe(true);
    // 已有内容没被覆盖
    expect(readFileSync(join(dir, 'workspaces', 'proj-a', 'canvases.json'), 'utf-8')).toBe('{"existing":true}');
    // 旧文件仍在原位(没被搬走)
    expect(existsSync(join(dir, 'canvases-proj-a.json'))).toBe(true);
  });

  it('单个项目失败不影响其余项目继续迁移', () => {
    seedFlat(['bad', 'good']);
    mkdirSync(join(dir, 'workspaces', 'bad'), { recursive: true });
    writeFileSync(join(dir, 'workspaces', 'bad', 'canvases.json'), '{"existing":true}');

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    expect(r.failures.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'workspaces', 'good', 'canvases.json'))).toBe(true);
    expect(readFileSync(join(dir, 'workspaces', 'good', 'memory.json'), 'utf-8')).toContain('good');
  });
});

describe('runDataMigration · 全新安装', () => {
  it('没有任何项目数据时标记为已迁移,不建目录', () => {
    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    expect(r.ran).toBe(false);
    expect(r.skipped).toContain('全新安装');
    expect(existsSync(join(dir, 'workspaces'))).toBe(false);
  });
});

/* ═══ 批次2:项目资源从全局 assets.json 拆分到 workspaces/<pid>/assets.json ═══ */

describe('runDataMigration · 项目资源拆分(批次2)', () => {
  /** 铺一份含「全局资源 + 项目资源」的 assets.json */
  function seedAssets(): void {
    writeFileSync(
      join(dir, 'assets.json'),
      JSON.stringify(
        {
          version: 2,
          assets: [
            { id: 'asset-global-1', name: '全局图', projectId: undefined, localPath: '/x/a.jpg' },
            { id: 'asset-p1-a', name: 'P1 图', projectId: 'p1', localPath: '/x/b.jpg' },
            { id: 'asset-p1-b', name: 'P1 图2', projectId: 'p1', localPath: '/x/c.jpg' },
            { id: 'asset-p2-a', name: 'P2 图', projectId: 'p2', localPath: '/x/d.jpg' },
          ],
          categories: [
            { id: 'cat-global', name: '全局分类' },
            { id: 'cat-p1', name: 'P1 分类', projectId: 'p1' },
          ],
        },
        null,
        2,
      ),
    );
    // 需要至少一个旧文件,迁移器才会进入主流程
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1' }, { id: 'p2' }] }));
    writeFileSync(join(dir, 'canvases-p1.json'), '{"canvases":[]}');
  }

  it('项目资源拆到各自文件,全局资源留在全局文件', () => {
    seedAssets();
    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    // 3 条项目资产(p1×2 + p2×1)+ 1 条项目分类(cat-p1)= 4
    expect(r.assetsSplit).toBe(4);
    // p1 文件:两条资产 + 一条分类
    const p1 = JSON.parse(readFileSync(join(dir, 'workspaces', 'p1', 'assets.json'), 'utf-8'));
    expect(p1.assets.map((a: { id: string }) => a.id).sort()).toEqual(['asset-p1-a', 'asset-p1-b']);
    expect(p1.categories.map((c: { id: string }) => c.id)).toEqual(['cat-p1']);
    // p2 文件
    const p2 = JSON.parse(readFileSync(join(dir, 'workspaces', 'p2', 'assets.json'), 'utf-8'));
    expect(p2.assets.map((a: { id: string }) => a.id)).toEqual(['asset-p2-a']);
    // 全局文件只剩全局资源与全局分类
    const g = JSON.parse(readFileSync(join(dir, 'assets.json'), 'utf-8'));
    expect(g.assets.map((a: { id: string }) => a.id)).toEqual(['asset-global-1']);
    expect(g.categories.map((c: { id: string }) => c.id)).toEqual(['cat-global']);
  });

  it('**不改写 localPath** —— 实体文件仍指向全局 assets/(只搬元数据)', () => {
    seedAssets();
    runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    const p1 = JSON.parse(readFileSync(join(dir, 'workspaces', 'p1', 'assets.json'), 'utf-8'));
    const a = p1.assets.find((x: { id: string }) => x.id === 'asset-p1-a');
    expect(a.localPath).toBe('/x/b.jpg'); // 原样保留,不重写
  });

  it('拆分前备份全局 assets.json(回滚依据)', () => {
    seedAssets();
    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });
    const bak = join(r.backupDir!, '(global).assets.before-split.json');
    expect(existsSync(bak)).toBe(true);
    const doc = JSON.parse(readFileSync(bak, 'utf-8'));
    expect(doc.assets).toHaveLength(4); // 备份是拆分**前**的完整 4 条
  });

  it('没有项目资源时不动 assets.json(不制造无意义写盘)', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1' }] }));
    writeFileSync(join(dir, 'canvases-p1.json'), '{"canvases":[]}');
    const only = JSON.stringify({ version: 2, assets: [{ id: 'g', localPath: '/x' }], categories: [] }, null, 2);
    writeFileSync(join(dir, 'assets.json'), only);

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    expect(r.assetsSplit).toBe(0);
    expect(readFileSync(join(dir, 'assets.json'), 'utf-8')).toBe(only); // 逐字节未变
  });

  it('续跑时合并而非覆盖(上次已拆出的条目不丢)', () => {
    seedAssets();
    // 模拟上次已拆过一半:p1 文件已存在且含一条
    mkdirSync(join(dir, 'workspaces', 'p1'), { recursive: true });
    writeFileSync(
      join(dir, 'workspaces', 'p1', 'assets.json'),
      JSON.stringify({ version: 2, assets: [{ id: 'asset-p1-existing', localPath: '/x/old.jpg' }], categories: [] }),
    );

    runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    const p1 = JSON.parse(readFileSync(join(dir, 'workspaces', 'p1', 'assets.json'), 'utf-8'));
    const ids = p1.assets.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual(['asset-p1-a', 'asset-p1-b', 'asset-p1-existing']); // 旧的 + 新拆的都在
  });

  it('旧版裸数组 assets.json 不拆(交给 AssetStore 的 V1 迁移处理)', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1' }] }));
    writeFileSync(join(dir, 'canvases-p1.json'), '{"canvases":[]}');
    writeFileSync(join(dir, 'assets.json'), JSON.stringify([{ id: 'a1', projectId: 'p1' }]));

    const r = runDataMigration({ dataDir: dir, now: new Date('2026-09-29T00:00:00Z') });

    expect(r.assetsSplit).toBe(0);
    expect(existsSync(join(dir, 'workspaces', 'p1', 'assets.json'))).toBe(false);
  });
});
