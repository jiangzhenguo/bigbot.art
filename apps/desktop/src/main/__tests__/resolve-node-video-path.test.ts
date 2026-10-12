/**
 * resolveNodeVideoPath 的 timeline 回退(2026-10「new1-gta1 无法使用」事故)。
 *
 * 事故形态:时间线成片 → 视频增强的连线建得出来,点运行却报「需要输入视频」——
 * 修复前导出的 timeline 节点只有 lastExport(展示 URL),没有 resultPath,
 * 而下游视频解析统一读 resultPath。timeline 源现在两层兜底:
 *  ① data.resultPath(新导出直接回写,渲染层另有愈合 effect 给旧节点补上);
 *  ② lastExport.name → resolveExportFile 按文件名解析导出目录(本文件锁这层)。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ⚠️ 先于模块加载设 HOME:export.ts 顶层按 BIGBOTART_HOME 求值 EXPORT_DIR
const tmpHome = mkdtempSync(join(tmpdir(), 'bba-nodevideo-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const { resolveNodeVideoPath } = await import('../tool-handlers');

const EXPORT_DIR = join(tmpHome, 'exports');
const noAsset = () => undefined;

describe('resolveNodeVideoPath', () => {
  beforeAll(() => {
    mkdirSync(EXPORT_DIR, { recursive: true });
    writeFileSync(join(EXPORT_DIR, '成片-1.mp4'), 'fake');
  });
  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('shot / video-upscale:直读 data.resultPath', () => {
    expect(
      resolveNodeVideoPath({ id: 's', kind: 'shot', data: { resultPath: '/o/s.mp4' } } as never, noAsset),
    ).toBe('/o/s.mp4');
  });

  it('asset 节点:走资产路径解析', () => {
    expect(
      resolveNodeVideoPath(
        { id: 'a', kind: 'asset', data: { assetId: 'asset-1' } } as never,
        (id) => (id === 'asset-1' ? '/assets/v.mp4' : undefined),
      ),
    ).toBe('/assets/v.mp4');
  });

  it('timeline:有 resultPath 直接用(新导出路径)', () => {
    expect(
      resolveNodeVideoPath({ id: 't', kind: 'timeline', data: { resultPath: '/exp/t.mp4' } } as never, noAsset),
    ).toBe('/exp/t.mp4');
  });

  it('timeline:缺 resultPath 时按 lastExport.name 回退解析导出目录(旧数据愈合;含中文名)', () => {
    const node = {
      id: 't',
      kind: 'timeline',
      data: { lastExport: { path: 'bba-output://x.mp4', name: '成片-1.mp4' } },
    } as never;
    expect(resolveNodeVideoPath(node, noAsset)).toBe(join(EXPORT_DIR, '成片-1.mp4'));
  });

  it('timeline:lastExport 指向的文件已不存在 → undefined(调用方报「需要输入视频」,不伪造路径)', () => {
    const node = {
      id: 't',
      kind: 'timeline',
      data: { lastExport: { path: 'bba-output://gone.mp4', name: 'gone.mp4' } },
    } as never;
    expect(resolveNodeVideoPath(node, noAsset)).toBeUndefined();
  });

  it('timeline:既无 resultPath 也无 lastExport → undefined', () => {
    expect(resolveNodeVideoPath({ id: 't', kind: 'timeline', data: {} } as never, noAsset)).toBeUndefined();
  });

  it('无节点 / 无产物的普通节点 → undefined', () => {
    expect(resolveNodeVideoPath(undefined, noAsset)).toBeUndefined();
    expect(resolveNodeVideoPath({ id: 'g', kind: 'image-gen', data: {} } as never, noAsset)).toBeUndefined();
  });
});
