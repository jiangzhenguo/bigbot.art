/**
 * 项目包导入/导出测试(.bba)—— 取代原「H3Mise 项目导入」入口的那条链路
 *
 * 这是**用户数据出口与入口的关键路径**:导出写坏 = 备份报废;导入写坏 = 覆盖既有项目。
 * 因此锁死以下不变量(每条都对应一种真实会发生的损坏形态):
 *
 *  1. **往返无损** —— 导出→导入后,画布节点/连线/分组/提示词逐项一致(节点 id 原样保留,
 *     画布 id 与项目 id 重新分配);
 *  2. **绝不覆盖既有项目** —— 导入一律新建项目,原项目数据原封不动(同 id 也不复用);
 *  3. **附件实体真的进包、真的落盘** —— 参考图/剧本这类**用户无法重跑**的输入丢了就是真丢了,
 *     所以断言导入后新路径存在且内容逐字节一致;
 *  4. **产物不进包但路径保留** —— resultPath 原样留着(同机重装仍有效),缺失时进 warnings
 *     而不是伪造文件(本项目反复出现的「假成功」形态);
 *  5. **格式/版本防护** —— 非包文件、损坏 JSON、高版本包一律明确拒绝;
 *  6. **未完成任务不装活** —— 包里 queued/running 的 Take 导入后一律 failed(那个任务
 *     只存在于导出端进程里,导入端永远等不到终态,否则永久显示「排队中」)。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ⚠️ 必须先设 BIGBOTART_HOME 再加载任何 Store 模块 ——
 * workspace-paths / assets 的目录常量在 import 时按 env 求值(与 migrate.test.ts 同约定)。 */
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-pkg-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

let ProjectStore: typeof import('../store').ProjectStore;
let AssetStore: typeof import('../assets').AssetStore;
let TakeStore: typeof import('../takes').TakeStore;
let MemoryStore: typeof import('../memory').MemoryStore;
let pkg: typeof import('../project-package');

let store: InstanceType<typeof ProjectStore>;
let assets: InstanceType<typeof AssetStore>;
let takes: InstanceType<typeof TakeStore>;
let memory: InstanceType<typeof MemoryStore>;
let deps: {
  store: InstanceType<typeof ProjectStore>;
  assets: InstanceType<typeof AssetStore>;
  takes: InstanceType<typeof TakeStore>;
  memory: InstanceType<typeof MemoryStore>;
};

beforeAll(async () => {
  ({ ProjectStore } = await import('../store'));
  ({ AssetStore } = await import('../assets'));
  ({ TakeStore } = await import('../takes'));
  ({ MemoryStore } = await import('../memory'));
  pkg = await import('../project-package');
});

beforeEach(() => {
  // 每个用例一套全新 Store(缓存型 Store 不能跨用例复用)
  store = new ProjectStore();
  assets = new AssetStore();
  takes = new TakeStore();
  memory = new MemoryStore();
  deps = { store, assets, takes, memory };
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  mkdirSync(tmpHome, { recursive: true });
});

/* ────────────────────────── 测试夹具 ────────────────────────── */

/** 铺一个有画布、有 Take、有附件、有记忆的项目 */
function seedProject(): { projectId: string; canvasId: string; attachmentPath: string } {
  const project = store.createProject('草原之河');
  const pid = project.id;
  const canvas = store.createCanvas(pid, '主画布');
  const canvasId = canvas.id;

  // 一个 shot 节点 + 一个 asset 节点 + 一条连线 + 一个分组
  const shotNode = {
    id: 'n-shot-1',
    kind: 'shot' as const,
    position: { x: 100, y: 100 },
    label: '镜头 01',
    data: { prompt: '草原上奔跑的马', tier: 'draft', frames: 96, steps: 8, layers: 40, reuse: 1, seed: 7, refs: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const assetNode = {
    id: 'n-asset-1',
    kind: 'asset' as const,
    position: { x: 400, y: 100 },
    label: '参考图',
    data: { assetId: 'asset-ref-1', mediaType: 'image' as const },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.replaceCanvases(pid, {
    projectId: pid,
    canvases: [
      {
        id: canvasId,
        projectId: pid,
        name: '主画布',
        nodes: [shotNode as never, assetNode as never],
        edges: [{ id: 'e1', source: 'n-asset-1', target: 'n-shot-1', label: 'ref-image' }],
        groups: [{ id: 'g1', name: '第一幕', members: ['n-shot-1'], createdAt: new Date().toISOString() }],
        version: 3,
        viewport: { x: 12, y: 34, z: 0.9 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    activeCanvasId: canvasId,
  });

  // 附件实体(真实的独立文件,内容可逐字节比对)
  const attachmentPath = join(tmpHome, 'source-ref.png');
  const bytes = Buffer.from('PNG-FAKE-CONTENT-0123456789', 'utf-8');
  writeFileSync(attachmentPath, bytes);
  assets.importParsed(pid, [
    {
      id: 'asset-ref-1',
      kind: 'image',
      name: '参考图',
      localPath: attachmentPath,
      projectId: pid,
      source: 'import',
      tags: ['素材'],
      createdAt: new Date().toISOString(),
    },
    {
      // 产物类资产:不应进包(见文件头不变量 4)
      id: 'asset-product-1',
      kind: 'video',
      name: '产物',
      localPath: join(tmpHome, 'outputs', 'shot.mp4'),
      projectId: pid,
      source: 'product',
      originNodeId: 'n-shot-1',
      tags: [],
      createdAt: new Date().toISOString(),
    },
  ]);

  takes.append(pid, {
    shotNodeId: 'n-shot-1',
    status: 'succeeded',
    params: { prompt: '草原上奔跑的马' },
    resultPath: join(tmpHome, 'outputs', 'shot.mp4'),
  });
  takes.append(pid, {
    shotNodeId: 'n-shot-1',
    status: 'running',
    params: {},
  });

  memory.updateCore(pid, 'styleGuide', '暖色调 · 长焦');
  memory.addArchival(pid, '主角叫阿云', ['角色'], canvasId);

  return { projectId: pid, canvasId, attachmentPath };
}

/* ────────────────────────── 1. 纯函数的边界 ────────────────────────── */

describe('格式与文件名 · 纯函数', () => {
  it('safeFileStem 清掉路径分隔符与危险字符,保留中文', () => {
    expect(pkg.safeFileStem('草原之河/短剧')).toBe('草原之河_短剧');
    // `../` 里的 / 先被替换成 _,`..` 再被 ^\.+ 剥掉 → 不会残留可用于穿越的片段
    expect(pkg.safeFileStem('  ../etc/passwd ')).toBe('_etc_passwd');
    expect(pkg.safeFileStem('..')).toBe('project');
    expect(pkg.safeFileStem('')).toBe('project');
  });

  it('safeFileStem 截断超长名(≤60)', () => {
    expect(pkg.safeFileStem('x'.repeat(200)).length).toBe(60);
  });

  it('defaultPackageName 带日期戳且以 .bba 结尾', () => {
    const p = store.createProject('我的项目');
    const name = pkg.defaultPackageName(p, new Date('2026-10-09T00:00:00Z'));
    expect(name).toBe('我的项目-20261009.bba');
  });

  it('isPackableAsset:产物与软删条目不进包', () => {
    const base: import('@bigbotart/shared').Asset = {
      id: 'a', kind: 'image', name: 'n', localPath: '/x/y.png', tags: [], createdAt: '',
    };
    expect(pkg.isPackableAsset({ ...base, source: 'import' })).toBe(true);
    expect(pkg.isPackableAsset({ ...base, source: 'attachment' })).toBe(true);
    expect(pkg.isPackableAsset({ ...base, source: 'product' })).toBe(false);
    expect(pkg.isPackableAsset({ ...base, source: 'import', deletedAt: '2026-01-01' })).toBe(false);
    expect(pkg.isPackableAsset({ ...base, source: 'import', localPath: '' })).toBe(false);
  });

  it('validatePackageShape 逐条拒绝不合规包', () => {
    expect(pkg.validatePackageShape(null)).toContain('有效的项目包');
    expect(pkg.validatePackageShape({})).toContain('format');
    expect(pkg.validatePackageShape({ format: 'other', version: 1 })).toContain('format');
    expect(pkg.validatePackageShape({ format: 'bigbotart-project', version: 0 })).toContain('版本');
    expect(pkg.validatePackageShape({ format: 'bigbotart-project', version: 99 })).toContain('高于当前应用支持');
    expect(
      pkg.validatePackageShape({ format: 'bigbotart-project', version: 1, payload: {} }),
    ).toContain('项目元数据');
  });

  it('computeStats 汇总画布/节点/连线/媒体体积', () => {
    const stats = pkg.computeStats({
      project: {} as never,
      canvases: {
        projectId: 'p',
        activeCanvasId: 'c1',
        canvases: [
          { nodes: [{}, {}], edges: [{}] } as never,
          { nodes: [{}], edges: [] } as never,
        ],
      },
      takes: [{}, {}] as never,
      memory: null,
      assets: [{}] as never,
      assetCategories: [],
      media: [
        { key: 'a', kind: 'asset', name: 'a.png', originalPath: '', bytes: 100, dataBase64: '' },
        { key: 'b', kind: 'asset', name: 'b.png', originalPath: '', bytes: 50, dataBase64: '' },
      ],
    });
    expect(stats).toMatchObject({ canvases: 2, nodes: 3, edges: 1, takes: 2, assets: 1, mediaFiles: 2, mediaBytes: 150 });
  });

  it('mediaFileName 保留扩展名并加序号前缀', () => {
    const name = pkg.mediaFileName(
      { key: 'asset-1.png', kind: 'asset', name: '参考 图.png', originalPath: '', bytes: 1, dataBase64: '' },
      3,
    );
    expect(name.startsWith('003-')).toBe(true);
    expect(name.endsWith('.png')).toBe(true);
    expect(name).not.toContain(' ');
  });

  it('rewriteAssetPaths:命中 key 的改路径,未命中的原样保留并计入 missing', () => {
    const { assets: out, copied, missing } = pkg.rewriteAssetPaths(
      [
        { id: 'a', name: '甲.png', localPath: '/old/a.png' } as never,
        { id: 'b', localPath: '/old/b.png' } as never, // 无 name → missing 回落 id
      ],
      new Map([['a', 'a.png'], ['b', 'b.png']]),
      new Map([['a.png', '/new/a.png']]), // b 没落盘成功
    );
    expect(copied).toBe(1);
    expect(missing).toEqual(['b']);
    expect(out[0]!.localPath).toBe('/new/a.png');
    expect(out[1]!.localPath).toBe('/old/b.png');
  });
});

/* ────────────────────────── 2. 序列化往返 ────────────────────────── */

describe('序列化 · gzip 往返', () => {
  it('serializePackage → parsePackage 内容一致', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    const back = pkg.parsePackage(pkg.serializePackage(built));
    expect(back.format).toBe('bigbotart-project');
    expect(back.version).toBe(1);
    expect(back.payload.project.name).toBe('草原之河');
    expect(back.payload.canvases.canvases).toHaveLength(1);
    expect(back.payload.media).toHaveLength(1);
    expect(back.stats).toEqual(built.stats);
  });

  it('包体是 gzip(魔数 1f 8b),不是裸 JSON', () => {
    const { projectId } = seedProject();
    const buf = pkg.serializePackage(pkg.buildProjectPackage(projectId, deps));
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it('非 gzip 内容明确报「不是有效的 .bba」(不静默返回空包)', () => {
    expect(() => pkg.parsePackage(Buffer.from('{"hello":1}'))).toThrow(/不是有效的 \.bba/);
  });

  it('gzip 里是坏 JSON 时报「内容损坏」', () => {
    const { gzipSync } = require('node:zlib') as typeof import('node:zlib');
    expect(() => pkg.parsePackage(gzipSync(Buffer.from('{not json')))).toThrow(/内容损坏/);
  });

  it('高版本包明确拒绝而不是猜着读', () => {
    const { gzipSync } = require('node:zlib') as typeof import('node:zlib');
    const future = gzipSync(Buffer.from(JSON.stringify({ format: 'bigbotart-project', version: 99, payload: {} })));
    expect(() => pkg.parsePackage(future)).toThrow(/高于当前应用支持/);
  });
});

/* ────────────────────────── 3. 导出内容口径 ────────────────────────── */

describe('导出 · 收什么不收什么', () => {
  it('画布/连线/分组/视口/提示词全在包里', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    const c = built.payload.canvases.canvases[0]!;
    expect(c.nodes).toHaveLength(2);
    expect(c.edges).toHaveLength(1);
    expect(c.groups).toEqual([{ id: 'g1', name: '第一幕', members: ['n-shot-1'], createdAt: expect.any(String) }]);
    expect(c.viewport).toEqual({ x: 12, y: 34, z: 0.9 });
    expect((c.nodes.find((n) => n.id === 'n-shot-1')!.data as { prompt: string }).prompt).toBe('草原上奔跑的马');
  });

  it('Take 历史全带(含终态与 params)', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    expect(built.payload.takes).toHaveLength(2);
    expect(built.payload.takes.some((t) => t.status === 'succeeded')).toBe(true);
  });

  it('附件实体进包,产物类资产不进 media', () => {
    const { projectId, attachmentPath } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    // 附件进了 media
    const media = built.payload.media.find((m) => m.originalPath === attachmentPath);
    expect(media).toBeTruthy();
    expect(Buffer.from(media!.dataBase64, 'base64').toString('utf-8')).toBe('PNG-FAKE-CONTENT-0123456789');
    // 产物资产没有 media 条目
    expect(built.payload.media.some((m) => m.originalPath.endsWith('shot.mp4'))).toBe(false);
    // 但它的元数据仍在(节点要靠 assetId 引用)
    expect(built.payload.assets.some((a) => a.id === 'asset-product-1')).toBe(true);
  });

  it('记忆进包', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    expect(built.payload.memory?.core.styleGuide).toBe('暖色调 · 长焦');
    expect(built.payload.memory?.archival).toHaveLength(1);
  });

  it('项目不存在时明确抛错', () => {
    expect(() => pkg.buildProjectPackage('proj-nonexistent', deps)).toThrow(/项目不存在/);
  });
});

/* ────────────────────────── 4. 导入往返 ────────────────────────── */

describe('导入 · 往返无损且绝不覆盖既有项目', () => {
  it('导入建新项目,结构逐项一致,原项目原封不动', () => {
    const { projectId } = seedProject();
    const before = store.listProjects().length;
    const built = pkg.buildProjectPackage(projectId, deps);

    const res = pkg.materializePackage(built, deps);
    expect(res.ok).toBe(true);
    expect(res.project).toBeTruthy();
    const newId = res.project!.id;

    // 新项目 ≠ 原项目;项目数 +1
    expect(newId).not.toBe(projectId);
    expect(store.listProjects().length).toBe(before + 1);

    // 原项目数据原封不动
    const orig = store.loadProjectCanvases(projectId);
    expect(orig.canvases).toHaveLength(1);
    expect(orig.canvases[0]!.nodes).toHaveLength(2);

    // 新项目画布内容一致(id 重分配,节点 id 原样)
    const mine = store.loadProjectCanvases(newId);
    expect(mine.canvases).toHaveLength(1);
    expect(mine.canvases[0]!.id).not.toBe(built.payload.canvases.canvases[0]!.id);
    expect(mine.canvases[0]!.projectId).toBe(newId);
    expect(mine.canvases[0]!.nodes.map((n) => n.id).sort()).toEqual(['n-asset-1', 'n-shot-1']);
    expect((mine.canvases[0]!.nodes.find((n) => n.id === 'n-shot-1')!.data as { prompt: string }).prompt).toBe(
      '草原上奔跑的马',
    );
    expect(mine.canvases[0]!.edges).toHaveLength(1);
    expect(mine.canvases[0]!.groups).toEqual([{ id: 'g1', name: '第一幕', members: ['n-shot-1'], createdAt: expect.any(String) }]);
    expect(mine.activeCanvasId).toBe(mine.canvases[0]!.id);
    expect(mine.canvases[0]!.name).toBe('主画布');
    expect(mine.canvases[0]!.viewport).toEqual({ x: 12, y: 34, z: 0.9 });
  });

  it('附件实体真落盘,内容逐字节一致,localPath 指向新位置', () => {
    const { projectId, attachmentPath } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    const res = pkg.materializePackage(built, deps);
    const newId = res.project!.id;

    const imported = assets.list(newId).find((a) => a.name === '参考图' && a.source === 'import');
    expect(imported).toBeTruthy();
    expect(imported!.localPath).not.toBe(attachmentPath);
    expect(existsSync(imported!.localPath)).toBe(true);
    expect(readFileSync(imported!.localPath, 'utf-8')).toBe('PNG-FAKE-CONTENT-0123456789');
    // 归属新项目,不再挂在原项目上
    expect(imported!.projectId).toBe(newId);
  });

  it('Take 历史带过去(含终态),running 被改判 failed', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    const res = pkg.materializePackage(built, deps);
    const list = takes.list(res.project!.id);
    expect(list).toHaveLength(2);
    expect(list.filter((t) => t.status === 'succeeded')).toHaveLength(1);
    // 包里那条 running 绝不能原样留下(导入端永远等不到它的终态)
    const running = list.find((t) => t.params && Object.keys(t.params).length === 0)!;
    expect(running.status).toBe('failed');
    expect(running.error).toContain('未完成');
  });

  it('记忆带过去,projectId/画布级键重指向新项目', () => {
    const { projectId, canvasId } = seedProject();
    // 画布级记忆必须真的存在才测得到重映射:激活技能会写 canvasMemory[canvasId]
    memory.setActiveSkillId(projectId, canvasId, 'skill-1');
    memory.updateCanvasSummary(projectId, canvasId, '第一幕已铺', 2);
    const built = pkg.buildProjectPackage(projectId, deps);
    expect(Object.keys(built.payload.memory!.canvasMemory)).toContain(canvasId);

    const res = pkg.materializePackage(built, deps);
    const newId = res.project!.id;
    const m = memory.get(newId);
    expect(m.projectId).toBe(newId);
    expect(m.core.styleGuide).toBe('暖色调 · 长焦');
    expect(m.archival).toHaveLength(1);
    // canvasMemory 的键必须是**新画布 id**,不能留旧 id(否则切画布读不到总结/激活技能)
    const newCanvasId = store.loadProjectCanvases(newId).canvases[0]!.id;
    expect(newCanvasId).not.toBe(canvasId);
    expect(Object.keys(m.canvasMemory)).toContain(newCanvasId);
    expect(Object.keys(m.canvasMemory)).not.toContain(canvasId);
    expect(m.canvasMemory[newCanvasId]!.summary).toBe('第一幕已铺');
    expect(memory.getActiveSkillId(newId, newCanvasId)).toBe('skill-1');
    // recall 的 canvasId 同样重指
    expect(m.recall.every((r) => r.canvasId !== canvasId)).toBe(true);
  });

  it('assetId 引用被改写到新 id(资源 id 撞车时也不断链)', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    const res = pkg.materializePackage(built, deps);
    const newId = res.project!.id;

    // 同进程往返必然撞 id(原项目还在),所以新项目里拿到的是一条**新 id** 的资源
    const list = assets.list(newId);
    expect(list).toHaveLength(2);
    const imported = list.find((a) => a.id !== 'asset-ref-1')!;
    expect(imported).toBeTruthy();
    // 关键:节点里的 assetId 必须跟着改写成新 id,否则画布显示「资产未加载」
    const canvas = store.loadProjectCanvases(newId).canvases[0]!;
    const assetNode = canvas.nodes.find((n) => n.id === 'n-asset-1')!;
    expect((assetNode.data as { assetId: string }).assetId).toBe(imported.id);
    expect(imported.localPath).toContain(newId);
    // 原项目那条引用没被顺带改坏
    const origCanvas = store.loadProjectCanvases(projectId).canvases[0]!;
    expect((origCanvas.nodes.find((n) => n.id === 'n-asset-1')!.data as { assetId: string }).assetId).toBe('asset-ref-1');
  });

  it('同机导入两次都能成功(id 重分配,不因冲突失败)', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    const r1 = pkg.materializePackage(built, deps);
    const r2 = pkg.materializePackage(built, deps);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.project!.id).not.toBe(r2.project!.id);
    expect(assets.list(r1.project!.id)).toHaveLength(2);
    expect(assets.list(r2.project!.id)).toHaveLength(2);
  });

  it('产物路径保留原值(不重写),本机存在时无缺产物告警', () => {
    const { projectId } = seedProject();
    // 造一个真实存在的「产物」文件,验证路径原样保留且不误报
    const productPath = join(tmpHome, 'outputs', 'shot.mp4');
    mkdirSync(join(tmpHome, 'outputs'), { recursive: true });
    writeFileSync(productPath, 'fake-mp4');
    const built = pkg.buildProjectPackage(projectId, deps);
    const res = pkg.materializePackage(built, deps);
    const list = takes.list(res.project!.id);
    expect(list.some((t) => t.resultPath === productPath)).toBe(true);
    expect(res.warnings ?? []).not.toContain(expect.stringContaining('生成产物不在本机'));
  });

  it('产物缺失时明确告警(不伪造文件、不静默)', () => {
    const { projectId } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    // 删掉产物文件后导入(模拟换机)
    const productPath = join(tmpHome, 'outputs', 'shot.mp4');
    rmSync(productPath, { force: true });
    const res = pkg.materializePackage(built, deps);
    expect(res.ok).toBe(true);
    expect((res.warnings ?? []).some((w) => w.includes('生成产物不在本机'))).toBe(true);
  });
});

/* ────────────────────────── 5. 文件级往返 ────────────────────────── */

describe('importProjectFromFile · 文件级入口', () => {
  it('写盘 → 读回 → 落项目,全链路成功', () => {
    const { projectId, attachmentPath } = seedProject();
    const pkgFile = join(tmpHome, '草原之河.bba');
    const bytes = pkg.writePackageFile(pkg.buildProjectPackage(projectId, deps), pkgFile);
    expect(bytes).toBeGreaterThan(0);
    expect(existsSync(pkgFile)).toBe(true);

    const res = pkg.importProjectFromFile(pkgFile, deps);
    expect(res.ok).toBe(true);
    expect(res.project!.name).toBe('草原之河');
    expect(res.stats!.nodes).toBe(2);
    // 附件真的跟着过来了
    const imported = assets.list(res.project!.id).find((a) => a.id.startsWith('asset-') && a.source === 'import');
    expect(imported).toBeTruthy();
    expect(existsSync(imported!.localPath)).toBe(true);
    expect(imported!.localPath).not.toBe(attachmentPath);
  });

  it('文件不存在 → 明确错误(不抛异常)', () => {
    const res = pkg.importProjectFromFile(join(tmpHome, 'nope.bba'), deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('文件不存在');
  });

  it('随便一个文本文件当包导入 → 明确拒绝', () => {
    const bad = join(tmpHome, 'not-a-package.bba');
    writeFileSync(bad, 'this is not gzip');
    const res = pkg.importProjectFromFile(bad, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不是有效的 .bba');
    // 拒绝时绝不留下半个项目
    expect(store.listProjects()).toHaveLength(0);
  });
});

/* ────────────────────────── 6. exportProject 入口 ────────────────────────── */

describe('exportProject · 对话框与取消语义', () => {
  it('传 path 直接写盘,不弹对话框', async () => {
    const { projectId } = seedProject();
    const target = join(tmpHome, 'out.bba');
    let dialogCalled = false;
    const res = await pkg.exportProject(
      { projectId, path: target },
      { ...deps, showSaveDialog: async () => ((dialogCalled = true), null) },
    );
    expect(res.ok).toBe(true);
    expect(res.bytes).toBeGreaterThan(0);
    expect(dialogCalled).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it('用户取消保存对话框 → canceled,不是失败', async () => {
    const { projectId } = seedProject();
    const res = await pkg.exportProject({ projectId }, { ...deps, showSaveDialog: async () => null });
    expect(res.ok).toBe(false);
    expect(res.canceled).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('对话框返回值缺 .bba 后缀时自动补上', async () => {
    const { projectId } = seedProject();
    const target = join(tmpHome, 'noext');
    const res = await pkg.exportProject({ projectId }, { ...deps, showSaveDialog: async () => target });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(`${target}.bba`);
    expect(existsSync(`${target}.bba`)).toBe(true);
  });

  it('项目不存在 → 明确错误', async () => {
    const res = await pkg.exportProject(
      { projectId: 'proj-nope', path: join(tmpHome, 'x.bba') },
      { ...deps, showSaveDialog: async () => null },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('项目不存在');
  });
});

/* ────────────────────────── 7. 附件缺失的降级路径 ────────────────────────── */

describe('附件在包内缺失时不假装成功', () => {
  it('asset 元数据在但 media 被掏空 → 保留原路径并给 warnings,导入仍然成功', () => {
    const { projectId, attachmentPath } = seedProject();
    const built = pkg.buildProjectPackage(projectId, deps);
    // 模拟「包传坏了 / 手工裁掉了 media」:元数据还在,实体没了
    const tampered = { ...built, payload: { ...built.payload, media: [] } };
    const res = pkg.materializePackage(tampered, deps);
    expect(res.ok).toBe(true); // 不阻断导入
    expect((res.warnings ?? []).some((w) => w.includes('没有随包带过来'))).toBe(true);
    // localPath 原样保留(没有伪造副本),用户仍能在原机看到图
    const a = assets.list(res.project!.id).find((x) => x.name === '参考图' && x.source === 'import');
    expect(a!.localPath).toBe(attachmentPath);
  });

  it('附件实体不在磁盘上时不进包(导出端跳过),不算包损坏', () => {
    const { projectId, attachmentPath } = seedProject();
    rmSync(attachmentPath, { force: true });
    const built = pkg.buildProjectPackage(projectId, deps);
    // 文件没了 → 不收集 media,但元数据仍在(资产条目不能凭空消失)
    expect(built.payload.media).toHaveLength(0);
    expect(built.payload.assets.some((a) => a.id === 'asset-ref-1')).toBe(true);
    const res = pkg.materializePackage(built, deps);
    expect(res.ok).toBe(true);
  });
});
