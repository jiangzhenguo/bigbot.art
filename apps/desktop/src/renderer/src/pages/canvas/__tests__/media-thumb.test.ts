/**
 * 缩略图 URL 选择测试 —— 锁住「参考视频封面空白」这个真实事故(2026-09)。
 *
 * 事故形态:检查器「参考绑定」只写
 *   `<img src={isShotSrc ? outputUrlOf(path) : thumbSrc(path)} />`
 * 于是**视频** ref 拿到 `bba-asset://asset-x.mp4` / `bba-output://x.mp4` 塞进 `<img>`,
 * 浏览器不做视频解码 → onerror → 那一行左侧只剩一块空框(用户报「参考视频没有展示出封面」)。
 *
 * 关键防线有两条,分别对应下面两组用例:
 *  ① `isVideoPath` 只认**文件名扩展名**,不看源类型 —— 资产视频的 ref 只有 `assetId`
 *     (没有 path 字段),若用 `isShotSrc`(有没有 path)判断就会再次漏掉;
 *  ② `thumbImageSrc` 对视频一律返回 `{kind:'video'}`(交给 VideoPoster 抽帧),
 *     绝不返回可塞进 `<img>` 的 src。
 */
import { describe, it, expect } from 'vitest';
import { isVideoPath, thumbImageSrc, previewUrlOf, thumbSrc, outputUrlOf } from '../media.js';

describe('isVideoPath · 视频扩展名识别', () => {
  it('识别镜头产物与资产视频的常见容器', () => {
    expect(isVideoPath('/Users/x/ai/BigBotArt/.bigbotart/outputs/shot-1_2.mp4')).toBe(true);
    expect(isVideoPath('/Users/x/.bigbotart/assets/asset-1790491690265-qpsg.mp4')).toBe(true);
    expect(isVideoPath('/tmp/a.MOV')).toBe(true);
    expect(isVideoPath('/tmp/a.webm')).toBe(true);
    expect(isVideoPath('/tmp/a.mkv')).toBe(true);
  });

  it('图片 / 空值不算视频', () => {
    expect(isVideoPath('/tmp/a.png')).toBe(false);
    expect(isVideoPath('/tmp/a.jpg')).toBe(false);
    expect(isVideoPath('')).toBe(false);
    expect(isVideoPath(null)).toBe(false);
    expect(isVideoPath(undefined)).toBe(false);
  });

  it('只看文件名:目录名里带视频扩展名不误判', () => {
    // 事故预防:产物路径历史上出现过 `frames/xxx.mp4/` 这类书写
    expect(isVideoPath('/tmp/mp4.dir/frame.png')).toBe(false);
    expect(isVideoPath('/tmp/out.mp4/frame.png')).toBe(false);
    // 无扩展名(如 bba-asset:// 历史写法)不算视频 —— 交给 <img> 兜底,不回退成 video
    expect(isVideoPath('/tmp/noext')).toBe(false);
  });
});

describe('thumbImageSrc · 槽位缩略图分流', () => {
  const assetMp4 = '/Users/x/.bigbotart/assets/asset-1790491690265-qpsg.mp4';
  const outMp4 = '/Users/x/ai/BigBotArt/.bigbotart/outputs/shot-1790001542801-gyec_1790002944147.mp4';
  const assetPng = '/Users/x/.bigbotart/assets/asset-1789724925759-i2rs.png';
  const outPng = '/Users/x/ai/BigBotArt/.bigbotart/outputs/frames/shot-1-first-123.png';

  it('视频(资产 or 产物)→ 交给 VideoPoster,不给 <img> 可用的 src', () => {
    const a = thumbImageSrc(assetMp4);
    const b = thumbImageSrc(outMp4);
    expect(a).toEqual({ kind: 'video' });
    expect(b).toEqual({ kind: 'video' });
    // 回归守卫:绝不能把 mp4 的 URL 交给 <img>
    expect(JSON.stringify(a)).not.toContain('bba-');
    expect(JSON.stringify(b)).not.toContain('bba-');
  });

  it('图片 → bba-asset / bba-output 的原样 URL', () => {
    expect(thumbImageSrc(assetPng)).toEqual({ kind: 'img', src: thumbSrc(assetPng) });
    expect(thumbImageSrc(outPng)).toEqual({ kind: 'img', src: outputUrlOf(outPng) });
  });

  it('无路径(资产未加载)→ null,调用方渲染空框而不是坏图', () => {
    expect(thumbImageSrc(undefined)).toBeNull();
    expect(thumbImageSrc('')).toBeNull();
    expect(thumbImageSrc(null)).toBeNull();
  });

  it('资产视频虽无 /outputs/ 前缀,也必须走视频分支(事故根因)', () => {
    const t = thumbImageSrc(assetMp4);
    expect(t?.kind).toBe('video');
    // 对照:旧的 isShotSrc 判据(只按来源挑 URL)会给出一个 <img> 用的 asset URL,
    // 而该 URL 作为 <img> 必然 onerror —— 这里显式记录下来,防止有人把判据改回去
    expect(previewUrlOf(assetMp4)).toBe('bba-asset://asset-1790491690265-qpsg.mp4');
  });
});
