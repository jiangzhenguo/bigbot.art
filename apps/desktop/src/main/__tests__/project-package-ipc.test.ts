/**
 * 项目包 IPC 链路集成测试 —— 真跑 index.ts 注册的那几个 handler
 *
 * 单测 project-package.test.ts 覆盖模块内部逻辑;这里是**接线**:
 * handler → dialog(打桩)→ exportProject / importProjectFromFile → 真实 Store → 落盘。
 * 单独测它的理由:handler 里那些「取窗口 / 传 defaultPath / 补 .bba 后缀 / 取消语义」的
 * 胶水代码写错不会让任何单测变红,但会让用户在真机上点了没反应或文件落到错地方。
 *
 * ⚠️ **状态读写一律走 IPC handler**,不自己 new Store ——
 *  handler 闭包里持有的是 index.ts 构造的那一份 Store;测试里再 new 一份就是
 * 「两个写入者共享一个 projects.json」(本项目最难查的故障形态),会在测试里
 * 复现出「刚建的项目却报项目不存在」的假失败。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-pkg-ipc-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
process.env.BIGBOTART_DRYRUN = '1';

/** 捕获 ipcMain.handle 注册的通道 */
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', async () => {
  const actual = await import('./electron-stub');
  return {
    ...actual,
    app: {
      ...actual.app,
      isPackaged: false,
      getVersion: () => '0.1.0-test',
      // 不 resolve:让 index.ts 的 whenReady 回调(建窗口 / 设 Dock 图标)不执行,
      // 只保留我们真正要测的 handler 注册
      whenReady: () => new Promise(() => {}),
    },
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    },
  };
});

/** 调用一个已注册的 handler(渲染层 invoke 的等价物) */
function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler 未注册:${channel}`);
  return Promise.resolve(fn({}, ...args) as T);
}

/** 资产写入:走 index.ts 用的同一份 AssetStore 单例(见 assets.ts 的 __lastInstance 注释) */
let seedAssets: (projectId: string, list: unknown[]) => void;
let assetList: (projectId: string) => Array<{ id: string; localPath: string; source?: string }>;

beforeAll(async () => {
  await import('../index');
  const { AssetStore } = await import('../assets');
  seedAssets = (pid, list) => {
    const inst = AssetStore.__lastInstance;
    if (!inst) throw new Error('AssetStore 单例未构造');
    inst.importParsed(pid, list as never, []);
  };
  assetList = (pid) => AssetStore.__lastInstance!.list(pid);
}, 60000);

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('项目包 IPC 接线', () => {
  it('export-project-package 与 import-project-package 都已注册', () => {
    expect(handlers.has('export-project-package')).toBe(true);
    expect(handlers.has('import-project-package')).toBe(true);
  });

  it('导出 → 导入全链路:真写文件、真建新项目、结构一致、附件随包走', async () => {
    // ① 铺一个项目(全走 IPC,与 handler 共用同一份 Store)
    const project = await call<{ id: string; name: string }>('create-project', 'IPC 往返项目');
    const canvas = await call<{ id: string }>('create-canvas', project.id, '主画布');
    await call('save-canvas-snapshot', {
      id: canvas.id,
      projectId: project.id,
      name: '主画布',
      nodes: [
        {
          id: 'n1', kind: 'document', position: { x: 10, y: 20 }, label: '剧本',
          data: { markdown: '# 第一幕' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
      ],
      edges: [],
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // 附件:实体文件 + 元数据(落在同一份 AssetStore 上)
    const src = join(tmpHome, 'ref.txt');
    writeFileSync(src, '剧本草稿内容');
    seedAssets(project.id, [
      {
        id: 'asset-doc-1', kind: 'document', name: '草稿', localPath: src,
        projectId: project.id, source: 'import', tags: [], createdAt: new Date().toISOString(),
      },
    ]);

    // ② 导出(传 path → 不弹对话框)
    const target = join(tmpHome, 'roundtrip.bba');
    const exp = await call<{ ok: boolean; bytes?: number; stats?: { nodes: number; mediaFiles: number } }>(
      'export-project-package',
      { projectId: project.id, path: target },
    );
    expect(exp.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(exp.bytes).toBeGreaterThan(0);
    expect(exp.stats!.nodes).toBe(1);
    expect(exp.stats!.mediaFiles).toBe(1);

    // ③ 导入(传 path → 不弹对话框)
    const imp = await call<{ ok: boolean; project?: { id: string; name: string }; stats?: { nodes: number } }>(
      'import-project-package',
      { path: target },
    );
    expect(imp.ok).toBe(true);
    expect(imp.project!.name).toBe('IPC 往返项目');
    expect(imp.project!.id).not.toBe(project.id);
    expect(imp.stats!.nodes).toBe(1);

    // ④ 新项目里的画布真的读得回来
    const mine = await call<{ canvases: Array<{ nodes: Array<{ label: string }> }> }>(
      'load-project-canvases',
      imp.project!.id,
    );
    expect(mine.canvases).toHaveLength(1);
    expect(mine.canvases[0]!.nodes[0]!.label).toBe('剧本');

    // ⑤ 附件实体随包过去且内容一致(用户无法重跑的输入,丢了就是真丢了)
    const imported = assetList(imp.project!.id).find((a) => a.source === 'import');
    expect(imported).toBeTruthy();
    expect(existsSync(imported!.localPath)).toBe(true);
    expect(readFileSync(imported!.localPath, 'utf-8')).toBe('剧本草稿内容');

    // ⑥ 原项目没被动过
    const orig = await call<{ canvases: unknown[] }>('load-project-canvases', project.id);
    expect(orig.canvases).toHaveLength(1);
  });

  it('导入不存在的文件 → ok:false,且不留下半个项目', async () => {
    const before = (await call<unknown[]>('list-projects')).length;
    const res = await call<{ ok: boolean; error?: string }>('import-project-package', { path: join(tmpHome, 'nope.bba') });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('文件不存在');
    expect((await call<unknown[]>('list-projects')).length).toBe(before);
  });

  it('导出不存在的项目 → ok:false 带明确错误,且不写文件', async () => {
    const target = join(tmpHome, 'ghost.bba');
    const res = await call<{ ok: boolean; error?: string }>('export-project-package', {
      projectId: 'proj-does-not-exist',
      path: target,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('项目不存在');
    expect(existsSync(target)).toBe(false);
  });

  it('对话框被取消时导入返回 canceled(不报错、不建项目)', async () => {
    const before = (await call<unknown[]>('list-projects')).length;
    // 打桩的 showOpenDialog 恒返回 canceled:true
    const res = await call<{ ok: boolean; canceled?: boolean; error?: string }>('import-project-package', undefined);
    expect(res.ok).toBe(false);
    expect(res.canceled).toBe(true);
    expect(res.error).toBeUndefined();
    expect((await call<unknown[]>('list-projects')).length).toBe(before);
  });

  it('对话框被取消时导出返回 canceled(不写文件)', async () => {
    const p = await call<{ id: string }>('create-project', '取消导出项目');
    const res = await call<{ ok: boolean; canceled?: boolean; error?: string }>('export-project-package', { projectId: p.id });
    expect(res.ok).toBe(false);
    expect(res.canceled).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('坏文件当包导入 → 明确拒绝且不建项目', async () => {
    const bad = join(tmpHome, 'bad.bba');
    writeFileSync(bad, 'not a package at all');
    const before = (await call<unknown[]>('list-projects')).length;
    const res = await call<{ ok: boolean; error?: string }>('import-project-package', { path: bad });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不是有效的 .bba');
    expect((await call<unknown[]>('list-projects')).length).toBe(before);
  });
});
