/**
 * 编辑节点「输入图」解析单测 —— ImageEditInspector 的 resolveEditInputImage
 *
 * 事故背景(2026-09,用户反馈「输入节点 的图片没显示」):
 * 上游连的是 **asset 节点**时,检查器来源卡写着「asset · 产物直通」,但**一个图都不显示**。
 * 根因是解析器一律读 `upNode.data.resultPath`,而 asset 节点的图在资产库里
 * (只有 `data.assetId` + assetCache 映射),resultPath 恒为空 → src = null。
 *
 * 本文件锁三件事:
 *  ① asset 上游必须能出图(事故回归);
 *  ② 非 asset 上游仍走 resultPath(别把已好的路径改坏);
 *  ③ 优先级顺序:Asset 直绑 > shot 抽帧 > 上游直通。
 */
import { describe, it, expect } from 'vitest';
import { resolveEditInputImage, assetIdFieldState, inspectorCardVisibility } from '../inspector/ImageEditInspector';
import type { CanvasNode } from '../types';

const node = (id: string, kind: string, data: Record<string, unknown> = {}, title?: string): CanvasNode =>
  ({ id, title: title ?? id, x: 0, y: 0, w: 200, kind: kind as CanvasNode['kind'], data }) as CanvasNode;

const base = { inputAssetId: '', nodes: [] as CanvasNode[], assetCache: {} as Record<string, string> };

describe('resolveEditInputImage — asset 上游必须能出图(事故回归)', () => {
  const assetUp = node('a1', 'asset', { mediaType: 'image', assetId: 'asset-xyz' }, '参考图 30');

  it('asset 上游:src 从 assetCache[assetId] 取,不再是 null', () => {
    const r = resolveEditInputImage({
      ...base,
      imgFrom: { nodeId: 'a1' },
      nodes: [assetUp],
      assetCache: { 'asset-xyz': '/Users/me/.bigbotart/assets/asset-xyz.webp' },
    });
    expect(r.src).toBe('bba-asset://asset-xyz.webp');
    expect(r.label).toBe('参考图 30');
    expect(r.sub).toBe('asset · 资产直通');
    expect(r.pill).toBe('asset');
  });

  it('asset 上游但资产未加载(assetCache 无该 id):src 为 null,不伪造 URL', () => {
    const r = resolveEditInputImage({
      ...base,
      imgFrom: { nodeId: 'a1' },
      nodes: [assetUp],
      assetCache: {},
    });
    expect(r.src).toBeNull();
    // 来源信息仍要如实给出,便于排查「是绑定丢了还是资产没加载」
    // (2026-10 加固:文案必须点明「未加载」并带上 assetId,不能再笼统写「资产直通」)
    expect(r.sub).toContain('资产未加载');
    expect(r.sub).toContain('asset-xyz');
  });

  it('asset 上游缺 assetId:src 为 null 且不抛异常', () => {
    const broken = node('a1', 'asset', {}, '坏资产节点');
    const r = resolveEditInputImage({ ...base, imgFrom: { nodeId: 'a1' }, nodes: [broken], assetCache: {} });
    expect(r.src).toBeNull();
    // 未绑定资产与「绑了但没加载」是两件事,文案不能混为一谈
    expect(r.sub).toContain('未绑定资产');
  });
});

describe('resolveEditInputImage — 非 asset 上游走产物路径', () => {
  it('image-gen 上游:走 data.resultPath(产物直通)', () => {
    // 真实产物路径形态:<home>/outputs/images/xxx.png(previewUrlOf 按 /outputs/ 判定走 bba-output)
    const gen = node('g1', 'image-gen', { resultPath: '/Users/me/.bigbotart/outputs/images/gen-1.png' }, '图片生成');
    const r = resolveEditInputImage({ ...base, imgFrom: { nodeId: 'g1' }, nodes: [gen], assetCache: {} });
    expect(r.src).toBe('bba-output://images/gen-1.png');
    expect(r.sub).toBe('image-gen · 产物直通');
    expect(r.pill).toBe('直通');
  });

  it('image-crop 上游:同样走 resultPath', () => {
    const crop = node('c1', 'image-crop', { resultPath: '/Users/me/.bigbotart/outputs/frames/crop-1.png' }, '裁切');
    const r = resolveEditInputImage({ ...base, imgFrom: { nodeId: 'c1' }, nodes: [crop], assetCache: {} });
    expect(r.src).toBe('bba-output://frames/crop-1.png');
    expect(r.pill).toBe('直通');
  });

  it('非 asset 上游 ref 指向 asset 但 kind 不是 asset:仍按 resultPath 解析(不误取资产)', () => {
    const weird = node('w1', 'image-gen', { assetId: 'asset-xyz' }, '怪节点');
    const r = resolveEditInputImage({
      ...base,
      imgFrom: { nodeId: 'w1' },
      nodes: [weird],
      assetCache: { 'asset-xyz': '/a/b.webp' },
    });
    expect(r.src).toBeNull(); // 没有 resultPath → 不出图,但也不该拿 assetCache 顶替
  });

  it('上游节点已删除(画布上找不到):src null 且 label 回落为 id', () => {
    const r = resolveEditInputImage({ ...base, imgFrom: { nodeId: 'gone' }, nodes: [], assetCache: {} });
    expect(r.src).toBeNull();
    expect(r.label).toBe('gone');
  });

  it('非 asset 上游但还没有产物:文案说「上游暂无产物」,不说「未加载」', () => {
    const gen = node('g1', 'image-gen', {}, '还没跑的图片生成');
    const r = resolveEditInputImage({ ...base, imgFrom: { nodeId: 'g1' }, nodes: [gen], assetCache: {} });
    expect(r.src).toBeNull();
    expect(r.sub).toContain('上游暂无产物');
    expect(r.sub).not.toContain('资产未加载');
  });
});

describe('resolveEditInputImage — 优先级', () => {
  it('Asset 直绑优先于上游连线', () => {
    const assetUp = node('a1', 'asset', { assetId: 'asset-up' });
    const r = resolveEditInputImage({
      inputAssetId: 'asset-direct',
      imgFrom: { nodeId: 'a1' },
      nodes: [assetUp],
      assetCache: { 'asset-direct': '/d/direct.png', 'asset-up': '/u/up.png' },
    });
    expect(r.src).toBe('bba-asset://direct.png');
    expect(r.pill).toBe('Asset 直绑');
  });

  it('shot 抽帧优先于上游直通(且不渲染大图,由取帧决定)', () => {
    const gen = node('g1', 'image-gen', { resultPath: '/Users/me/.bigbotart/outputs/g.png' }, '上游图');
    const r = resolveEditInputImage({
      ...base,
      frameSrc: { videoNodeId: 'shot1', at: 'last' },
      imgFrom: { nodeId: 'g1' },
      nodes: [gen, node('shot1', 'shot', {}, '镜头 03')],
      assetCache: {},
    });
    expect(r.src).toBeNull();
    expect(r.pill).toBe('抽帧');
    expect(r.sub).toBe('取帧 · 尾帧');
    expect(r.label).toBe('镜头 03');
  });

  it('没有任何输入:回落到「无输入」提示', () => {
    const r = resolveEditInputImage({ ...base });
    expect(r.src).toBeNull();
    expect(r.label).toBe('无输入');
    expect(r.pill).toBe('待绑定');
  });

  /* ↓↓↓ 2026-10 用户要求:参考图**不再占用「输入图」卡**,改用独立展示区(RefImagesCard)。
     本卡只回答「底图是谁」;仅参考图时如实说「无底图」并指路下方参考图区。 */
  it('只有 ref-image(无底图):输入图卡显示「无底图」并指路参考图区,不借用参考图的图', () => {
    const gen = node('pal1', 'image-gen', { resultPath: '/Users/me/.bigbotart/outputs/images/ref-1.png' }, '参考图 A');
    const r = resolveEditInputImage({
      ...base,
      refImageFrom: [{ nodeId: 'pal1' }, { nodeId: 'pal2' }],
      nodes: [gen],
    });
    expect(r.src).toBeNull(); // ⚠️ 关键:不把参考图当成输入图显示
    expect(r.label).toBe('无底图');
    expect(r.sub).toContain('参考图');
    expect(r.sub).toContain('2 张');
    expect(r.pill).toBe('仅参考图');
  });

  it('input 存在时 ref-image 不得抢占(优先级仍然正确)', () => {
    const gen = node('g1', 'image-gen', { resultPath: '/Users/me/.bigbotart/outputs/images/gen-1.png' }, '底图');
    const r = resolveEditInputImage({
      ...base,
      imgFrom: { nodeId: 'g1' },
      refImageFrom: [{ nodeId: 'pal1' }],
      nodes: [gen],
    });
    expect(r.src).toBe('bba-output://images/gen-1.png');
    expect(r.pill).toBe('直通');
  });

  it('refImageFrom 为空数组 / 元素缺 nodeId:仍回落「无输入」(不误报参考图)', () => {
    expect(resolveEditInputImage({ ...base, refImageFrom: [] }).label).toBe('无输入');
    expect(resolveEditInputImage({ ...base, refImageFrom: [{}, { nodeId: '' }] }).label).toBe('无输入');
  });

  it('Asset 直绑的 id 在 assetCache 里查不到时,不占用优先级、继续看下游', () => {
    const assetUp = node('a1', 'asset', { assetId: 'asset-up' }, '上游图');
    const r = resolveEditInputImage({
      inputAssetId: 'asset-missing',
      imgFrom: { nodeId: 'a1' },
      nodes: [assetUp],
      assetCache: { 'asset-up': '/u/up.png' },
    });
    // 直绑的资产没加载 → 退到上游 asset,而不是显示一个坏图
    expect(r.src).toBe('bba-asset://up.png');
    expect(r.pill).toBe('asset');
  });
});

/* ══════════════════════════════════════════════════════════════════
 * 「输入图 Asset ID」字段状态 —— 填了查不到的 ID 必须当场报错
 *
 * 背景:该字段填了会**压过连线**(提交侧顺序:取帧 → inputAssetId → 上游连线)。
 * 旧行为是填错不报错 —— assetCache 查不到就返回 undefined,被当成「没有输入图」,
 * 表现为「连线明明连着却不出图」,且没有任何提示,极难排查。
 * 这里锁住「查得到=ok / 查不到=invalid」,并确保不误伤异步加载中的合法 ID。
 * ══════════════════════════════════════════════════════════════════ */
describe('assetIdFieldState — 手填 Asset ID 校验', () => {
  const assetsList = [{ id: 'asset-a' }, { id: 'asset-b' }];

  it('空 / 纯空白 → empty(正常走连线)', () => {
    expect(assetIdFieldState('', assetsList, {})).toBe('empty');
    expect(assetIdFieldState('   ', assetsList, {})).toBe('empty');
  });

  it('资产清单里存在 → ok', () => {
    expect(assetIdFieldState('asset-a', assetsList, {})).toBe('ok');
  });

  it('前后有空格也能识别(用户从各处粘贴常带空白)', () => {
    expect(assetIdFieldState('  asset-a  ', assetsList, {})).toBe('ok');
  });

  it('清单里查无此 id → invalid(这才是要标红的真错误)', () => {
    expect(assetIdFieldState('asset-nonexistent', assetsList, {})).toBe('invalid');
  });

  it('清单未加载(空)但缓存已有路径 → ok,不误伤异步时序', () => {
    // assetCache 是权威的「路径已就绪」信号:清单可能还没刷新,此时不该标红
    expect(assetIdFieldState('asset-a', [], { 'asset-a': '/x/a.png' })).toBe('ok');
  });

  it('清单未加载且缓存也没有 → invalid(确实无从确认,报错比静默好)', () => {
    expect(assetIdFieldState('asset-a', [], {})).toBe('invalid');
  });

  it('缓存里有但清单里没有 → ok(以缓存为准,避免清单滞后误报)', () => {
    expect(assetIdFieldState('asset-z', assetsList, { 'asset-z': '/x/z.png' })).toBe('ok');
  });

  it('大小写/前后缀不做模糊匹配:必须精确相等', () => {
    expect(assetIdFieldState('ASSET-A', assetsList, {})).toBe('invalid');
    expect(assetIdFieldState('asset-a-extra', assetsList, {})).toBe('invalid');
  });
});

/* ══════════════════════════════════════════════════════════════════
 * 卡片显隐 —— 2026-10 用户要求:没有内容就不占位
 * 「无输入」空壳卡零信息量还把操作项挤下去;单张参考图没有「多张关联」可看。
 * ══════════════════════════════════════════════════════════════════ */
describe('inspectorCardVisibility — 无内容不占位', () => {
  it('什么都没绑:两块都不渲染', () => {
    const v = inspectorCardVisibility({ inputAssetId: '', refImageCount: 0 });
    expect(v.showInput).toBe(false);
    expect(v.showRefImages).toBe(false);
  });

  it('绑了 Asset 直绑:渲染输入图卡', () => {
    expect(inspectorCardVisibility({ inputAssetId: 'asset-a', refImageCount: 0 }).showInput).toBe(true);
  });

  it('连了上游 input 或 shot 抽帧:渲染输入图卡', () => {
    expect(inspectorCardVisibility({ inputAssetId: '', imgFrom: { nodeId: 'g1' }, refImageCount: 0 }).showInput).toBe(true);
    expect(inspectorCardVisibility({ inputAssetId: '', frameSrc: { videoNodeId: 's1' }, refImageCount: 0 }).showInput).toBe(true);
  });

  it('⚠️ 连了线但上游还没产物:仍渲染输入图卡(来源信息本身有用)', () => {
    const v = inspectorCardVisibility({ inputAssetId: '', imgFrom: { nodeId: 'not-run-yet' }, refImageCount: 0 });
    expect(v.showInput).toBe(true);
  });

  it('仅参考图、无底图:不渲染输入图卡(空壳),也不渲染单张参考图卡', () => {
    const v = inspectorCardVisibility({ inputAssetId: '', refImageCount: 1 });
    expect(v.showInput).toBe(false);
    expect(v.showRefImages).toBe(false);
  });

  it('参考图 >1 张:渲染参考图卡(多张关联才值得占位)', () => {
    expect(inspectorCardVisibility({ inputAssetId: '', refImageCount: 2 }).showRefImages).toBe(true);
    expect(inspectorCardVisibility({ inputAssetId: '', refImageCount: 9 }).showRefImages).toBe(true);
  });

  it('空 id / 空 nodeId 视为未绑定(脏数据不该让空壳卡复现)', () => {
    expect(inspectorCardVisibility({ inputAssetId: '   ', refImageCount: 0 }).showInput).toBe(false);
    expect(inspectorCardVisibility({ inputAssetId: '', imgFrom: { nodeId: '' }, refImageCount: 0 }).showInput).toBe(false);
    expect(inspectorCardVisibility({ inputAssetId: '', frameSrc: {}, refImageCount: 0 }).showInput).toBe(false);
  });
});
