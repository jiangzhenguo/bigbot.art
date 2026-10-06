/**
 * 资源(asset)节点检查器 —— 「参考图置顶」布局回归单测(2026-09-30 用户要求)
 *
 * 背景:资源节点检查器此前第一屏是**参数**——「媒体类型」chips + 「资产 ID」输入框 +
 * 两个换绑按钮,而真正要看的素材预览/参考图排在它们**下面**。点开一个视频资源,
 * 得先滚过一整块表单才看得到画面;与同期其它检查器(image-gen / image-edit /
 * video-upscale / image-crop …)已经统一的「预览置顶」口径也不一致。
 *
 * 本次改成固定四段次序:
 *   ① 素材预览 → ② 媒体信息 → ③ 绑定参数(媒体类型/资产 ID/按钮)→ ④ meta
 *
 * 为什么用**源码级次序断言**而不是渲染快照:检查器是一大段 JSX,引入 jsdom + RTL
 * 只为量「谁在谁上面」成本过高,而本项目现有 canvas 测试全是纯函数/源码断言口径。
 * 这里锁的是**结构不变量**(锚点在文件里的下标次序),恰好是回归时最容易被打乱的东西:
 * 后续任何人把资产 ID 字段挪回预览之前,这条测试立刻红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assetInspectorSrc = readFileSync(join(here, '..', 'inspector', 'AssetInspector.tsx'), 'utf8');
const paneSrc = readFileSync(join(here, '..', 'InspectorPane.tsx'), 'utf8');

/**
 * 某锚点在源码里的下标(找不到直接 -1,断言会给出可读差异)。
 *
 * ⚠️ 必须传**代码级**锚点(`<Lbl>素材预览</Lbl>` / `label="资产 ID…"`),
 * 不能用「素材预览」「媒体类型」这类裸词 —— 本文件顶部就有整段中文注释解释布局,
 * 裸词的 `indexOf` 会命中注释、给出与真实结构无关的下标(首版就踩中:
 * `'媒体类型'` 命中的是注释第 15 行而非 chips 的 151 行,断言无意义地失败)。
 * 下面每个锚点都刻意带上 JSX 定界符,保证只匹配真实渲染节点。
 */
const idx = (haystack: string, needle: string) => haystack.indexOf(needle);

describe('AssetInspector — 参考图/素材预览必须在绑定参数之上', () => {
  const previewAt = idx(assetInspectorSrc, '<Lbl>素材预览</Lbl>');
  const mediaInfoAt = idx(assetInspectorSrc, 'kind="image" live={liveMeta}');
  const mediaTypeAt = idx(assetInspectorSrc, '<span className="lbl">媒体类型</span>');
  const assetIdAt = idx(assetInspectorSrc, 'label="资产 ID(从资产中心复制)"');
  const bindBtnAt = idx(assetInspectorSrc, '从资源库选择…');

  it('四个锚点都真实存在(防锚点被改名后测试静默失效)', () => {
    for (const [name, at] of Object.entries({ previewAt, mediaInfoAt, mediaTypeAt, assetIdAt, bindBtnAt })) {
      expect(at, `${name} 未在 AssetInspector.tsx 中找到`).toBeGreaterThan(-1);
    }
  });

  it('① 素材预览 在最前 —— 早于媒体类型 / 资产 ID / 换绑按钮', () => {
    expect(previewAt).toBeLessThan(mediaTypeAt);
    expect(previewAt).toBeLessThan(assetIdAt);
    expect(previewAt).toBeLessThan(bindBtnAt);
  });

  it('② 媒体信息紧随预览,同样早于全部绑定参数', () => {
    expect(mediaInfoAt).toBeLessThan(mediaTypeAt);
    expect(mediaInfoAt).toBeLessThan(assetIdAt);
    expect(mediaInfoAt).toBeLessThan(bindBtnAt);
  });

  it('③ 绑定参数内部次序不变:媒体类型 → 资产 ID → 换绑按钮', () => {
    expect(mediaTypeAt).toBeLessThan(assetIdAt);
    expect(assetIdAt).toBeLessThan(bindBtnAt);
  });
});

describe('InspectorPane — asset 节点不再重复渲染顶部整块预览', () => {
  it('顶部 .preview 带有 `selNode.kind !== \'asset\'` 例外', () => {
    // 资源检查器自己第一条就是素材预览;这里若不加例外,同一张图会出现两遍
    expect(paneSrc).toContain("selNode.kind !== 'asset'");
  });

  it('例外只作用于顶部预览,不影响其余 kind 的预览渲染', () => {
    // 非 asset 节点仍要能出顶部预览(别把整块删掉)
    expect(paneSrc).toContain('selInfo && selInfo.img && selNode.kind !==');
    expect(paneSrc).toContain('选中节点预览');
  });
});
