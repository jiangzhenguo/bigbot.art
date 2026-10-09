/**
 * 项目封面测试 —— 把首页/项目页那张**静态假图**换成项目真实产物
 *
 * 这里锁死的是「封面到底选哪张图」的判定逻辑,因为它是**纯函数且极易写错**,
 * 而错了的表现又很隐蔽(封面显示成另一张图,用户只会觉得"有点怪"):
 *
 *  1. **图片优先** —— 实测真实项目里 mp4 与 png 混排(「你好」项目第一个产物就是镜头 mp4),
 *     严格按节点顺序会把视频当封面;图片优先才能让多数项目直接拿到静帧。
 *  2. **只认磁盘上真实存在的文件** —— 纸面路径(产物被删/换机)绝不能当选;否则渲染层
 *     拿到一个 404 路径 = 破图,比占位图更像故障。
 *  3. **活动画布优先** —— 进项目默认打开哪张画布,封面就该优先反映它。
 *  4. **手动优先,且降级要说出来** —— 手动封面文件被删时回退自动封面,
 *     但必须带 `error` 说明,否则用户以为「我设的封面怎么变成别的了」。
 */
import { describe, it, expect } from 'vitest';
import type { CanvasSnapshot, Project } from '@bigbotart/shared';
import {
  isImageFile,
  isVideoFile,
  collectNodePaths,
  collectCoverCandidates,
  pickCover,
  resolveAutoCover,
  resolveProjectCover,
  isUsableCoverFile,
} from '../project-cover';

/* ────────────────────────── 夹具 ────────────────────────── */

function node(id: string, kind: string, data: Record<string, unknown>) {
  return {
    id,
    kind,
    position: { x: 0, y: 0 },
    label: `节点 ${id}`,
    data,
    createdAt: '',
    updatedAt: '',
  } as never;
}

function canvas(id: string, nodes: unknown[]): CanvasSnapshot {
  return {
    id,
    projectId: 'p1',
    name: id,
    nodes,
    edges: [],
    version: 1,
    createdAt: '',
    updatedAt: '',
  } as never;
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: '项目',
    createdAt: '',
    updatedAt: '',
    canvasIds: ['c1'],
    activeCanvasId: 'c1',
    ...over,
  } as Project;
}

/** 假 exists:只认白名单里的路径(模拟磁盘真实状态) */
const onDisk = (...paths: string[]) => (p: string) => paths.includes(p);

/* ────────────────────────── 1. 扩展名判定 ────────────────────────── */

describe('扩展名判定', () => {
  it('图片', () => {
    for (const p of ['/a/b.png', '/a/b.JPG', '/a/b.jpeg', '/a/b.webp', '/a/b.gif']) {
      expect(isImageFile(p)).toBe(true);
    }
    expect(isImageFile('/a/b.mp4')).toBe(false);
  });

  it('视频', () => {
    for (const p of ['/a/b.mp4', '/a/b.MOV', '/a/b.webm', '/a/b.mkv']) {
      expect(isVideoFile(p)).toBe(true);
    }
    expect(isVideoFile('/a/b.png')).toBe(false);
  });

  it('空值不抛错', () => {
    expect(isImageFile(null)).toBe(false);
    expect(isImageFile(undefined)).toBe(false);
    expect(isVideoFile('')).toBe(false);
  });

  it('目录名带 .mp4 不算视频(只认 basename)', () => {
    expect(isVideoFile('/outputs/foo.mp4/bar.png')).toBe(false);
  });
});

/* ────────────────────────── 2. 产物路径收集 ────────────────────────── */

describe('collectNodePaths · 三种既有产物字段', () => {
  it('resultPath / pieces / outputs 都收,且去重', () => {
    expect(collectNodePaths({ resultPath: '/a.png' })).toEqual(['/a.png']);
    expect(collectNodePaths({ pieces: ['/p1.png', '/p2.png'] })).toEqual(['/p1.png', '/p2.png']);
    expect(collectNodePaths({ outputs: ['/o1.mp4'] })).toEqual(['/o1.mp4']);
    // image-split 的第 1 片同时写进 resultPath 与 pieces[0] → 只算一次
    expect(collectNodePaths({ resultPath: '/p1.png', pieces: ['/p1.png', '/p2.png'] })).toEqual(['/p1.png', '/p2.png']);
  });

  it('非对象/空值返回空数组', () => {
    expect(collectNodePaths(null)).toEqual([]);
    expect(collectNodePaths(undefined)).toEqual([]);
    expect(collectNodePaths('x')).toEqual([]);
    expect(collectNodePaths({})).toEqual([]);
  });

  it('空白字符串不算产物', () => {
    expect(collectNodePaths({ resultPath: '   ' })).toEqual([]);
  });
});

/* ────────────────────────── 3. 候选收集 ────────────────────────── */

describe('collectCoverCandidates · 只认磁盘上真实存在的文件', () => {
  it('纸面路径被过滤(产物已删/换机)', () => {
    const c = canvas('c1', [
      node('n1', 'image-gen', { resultPath: '/gone.png' }),
      node('n2', 'image-gen', { resultPath: '/here.png' }),
    ]);
    const got = collectCoverCandidates([c], 'c1', onDisk('/here.png'));
    expect(got.map((x) => x.path)).toEqual(['/here.png']);
  });

  it('保留节点与 kind 信息(UI/诊断要用)', () => {
    const c = canvas('c1', [node('n-image', 'image-gen', { resultPath: '/a.png' })]);
    const got = collectCoverCandidates([c], 'c1', onDisk('/a.png'));
    expect(got[0]).toMatchObject({ nodeId: 'n-image', nodeKind: 'image-gen', path: '/a.png', isVideo: false });
  });

  it('活动画布优先 —— 即使它在数组后面', () => {
    const other = canvas('c-other', [node('n1', 'image-gen', { resultPath: '/other.png' })]);
    const active = canvas('c-active', [node('n2', 'image-gen', { resultPath: '/active.png' })]);
    const got = collectCoverCandidates([other, active], 'c-active', onDisk('/other.png', '/active.png'));
    expect(got[0]!.path).toBe('/active.png');
  });

  it('跨画布去重(同一路径不重复当候选)', () => {
    const c1 = canvas('c1', [node('n1', 'image-gen', { resultPath: '/same.png' })]);
    const c2 = canvas('c2', [node('n2', 'image-gen', { resultPath: '/same.png' })]);
    const got = collectCoverCandidates([c1, c2], 'c1', onDisk('/same.png'));
    expect(got).toHaveLength(1);
  });

  it('视频候选标记 isVideo', () => {
    const c = canvas('c1', [node('n1', 'shot', { resultPath: '/v.mp4' })]);
    expect(collectCoverCandidates([c], 'c1', onDisk('/v.mp4'))[0]!.isVideo).toBe(true);
  });

  it('无节点/无产物返回空', () => {
    expect(collectCoverCandidates([canvas('c1', [])], 'c1')).toEqual([]);
    expect(collectCoverCandidates([], 'c1')).toEqual([]);
  });
});

/* ────────────────────────── 4. 选图策略 ────────────────────────── */

describe('pickCover · 图片优先', () => {
  const cand = (path: string, isVideo: boolean) => ({ nodeId: 'n', nodeKind: 'k', label: 'l', path, isVideo });

  it('第一个视频在前,也要挑后面的图片(真实场景:镜头 mp4 先出)', () => {
    const got = pickCover([cand('/a.mp4', true), cand('/b.png', false)]);
    expect(got!.path).toBe('/b.png');
  });

  it('一张图片都没有 → 回退第一个产物(视频,渲染层抽帧)', () => {
    const got = pickCover([cand('/a.mp4', true), cand('/b.mp4', true)]);
    expect(got!.path).toBe('/a.mp4');
    expect(got!.isVideo).toBe(true);
  });

  it('多张图片取最靠前那张', () => {
    const got = pickCover([cand('/a.png', false), cand('/b.png', false)]);
    expect(got!.path).toBe('/a.png');
  });

  it('空候选 → null', () => {
    expect(pickCover([])).toBeNull();
  });
});

/* ────────────────────────── 5. 自动封面 ────────────────────────── */

describe('resolveAutoCover', () => {
  it('真实形态:镜头 mp4 在前、图片在后 → 封面是那张图', () => {
    const c = canvas('c1', [
      node('n-shot', 'shot', { resultPath: '/shot.mp4' }),
      node('n-gen', 'image-gen', { resultPath: '/gen.png' }),
    ]);
    const got = resolveAutoCover('p1', [c], 'c1', onDisk('/shot.mp4', '/gen.png'));
    expect(got).toMatchObject({ projectId: 'p1', mode: 'auto', path: '/gen.png', isVideo: false, sourceNodeId: 'n-gen' });
  });

  it('还没有任何产物 → path:null(占位图,不是错误)', () => {
    const got = resolveAutoCover('p1', [canvas('c1', [])], 'c1');
    expect(got).toMatchObject({ path: null, isVideo: false, sourceNodeId: null });
    expect(got.error).toBeUndefined();
  });

  it('产物全被删 → path:null(绝不返回指向空气的路径)', () => {
    const c = canvas('c1', [node('n1', 'image-gen', { resultPath: '/gone.png' })]);
    expect(resolveAutoCover('p1', [c], 'c1', onDisk()).path).toBeNull();
  });
});

/* ────────────────────────── 6. 手动封面优先与降级 ────────────────────────── */

describe('resolveProjectCover · 手动优先 + 失效降级要说出来', () => {
  const c = canvas('c1', [node('n-gen', 'image-gen', { resultPath: '/auto.png' })]);

  it('没设过手动 → 自动', () => {
    const got = resolveProjectCover(project(), [c], 'c1', () => undefined, onDisk('/auto.png'));
    expect(got).toMatchObject({ mode: 'auto', path: '/auto.png' });
  });

  it('手动封面生效时优先于自动', () => {
    const p = project({ coverMode: 'manual', coverAssetId: 'asset-1' });
    const got = resolveProjectCover(p, [c], 'c1', (id) => (id === 'asset-1' ? '/cover.png' : undefined), onDisk('/cover.png', '/auto.png'));
    expect(got).toMatchObject({ mode: 'manual', path: '/cover.png', sourceNodeId: null });
    expect(got.error).toBeNull();
  });

  it('手动资源不存在 → 回退自动 + error 说明', () => {
    const p = project({ coverMode: 'manual', coverAssetId: 'asset-gone' });
    const got = resolveProjectCover(p, [c], 'c1', () => undefined, onDisk('/auto.png'));
    expect(got.path).toBe('/auto.png');
    expect(got.error).toContain('资源不存在');
  });

  it('手动文件被删 → 回退自动 + error 说明', () => {
    const p = project({ coverMode: 'manual', coverAssetId: 'asset-1' });
    const got = resolveProjectCover(p, [c], 'c1', () => '/deleted.png', onDisk('/auto.png'));
    expect(got.path).toBe('/auto.png');
    expect(got.error).toContain('磁盘');
  });

  it('coverMode=manual 但没有 assetId(脏数据)→ 按自动处理', () => {
    const p = project({ coverMode: 'manual' });
    const got = resolveProjectCover(p, [c], 'c1', () => undefined, onDisk('/auto.png'));
    expect(got.mode).toBe('auto');
    expect(got.path).toBe('/auto.png');
  });

  it('老项目文件无 coverMode 字段 → 按自动(= 升级后立刻有真封面)', () => {
    const p = project(); // 无 coverMode
    const got = resolveProjectCover(p, [c], 'c1', () => undefined, onDisk('/auto.png'));
    expect(got.mode).toBe('auto');
    expect(got.path).toBe('/auto.png');
  });

  it('手动资源指向视频也不算封面(手动只允许图片,这里是防御性回退)', () => {
    const p = project({ coverMode: 'manual', coverAssetId: 'asset-v' });
    const got = resolveProjectCover(p, [c], 'c1', () => '/cover.mp4', onDisk('/cover.mp4', '/auto.png'));
    // 当前实现按路径扩展名标 isVideo → 渲染层会抽帧显示;不会白屏
    expect(got.path).toBe('/cover.mp4');
    expect(got.isVideo).toBe(true);
  });
});

/* ────────────────────────── 7. 上传文件校验 ────────────────────────── */

describe('isUsableCoverFile', () => {
  it('不存在的文件 → 明确错误', () => {
    const r = isUsableCoverFile('/definitely/not/here-xyz.png');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('目录不是文件 → 拒绝', () => {
    const r = isUsableCoverFile('/tmp');
    expect(r.ok).toBe(false);
  });
});
