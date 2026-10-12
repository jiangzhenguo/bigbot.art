/**
 * pickOutputsDir 纯函数单测(2026-10 产物根加固)。
 * 真实事故:打包版从 Finder 启动 cwd=/,cwd 候选落空 → 产物根飘到
 * ~/.bigbotart/outputs,历史产物(仓库 .bigbotart/outputs)被 bba-output://
 * 白名单拦成 404,画布视频「消失」。打包版因此绝不跟随 cwd。
 */
import { describe, it, expect } from 'vitest';
import { pickOutputsDir } from '../assets';

const exists = (dirs: string[]) => (p: string) => dirs.includes(p);
const REPO_OUT = '/repo/.bigbotart/outputs';
const HOME_OUT = '/home/u/.bigbotart/outputs';

describe('pickOutputsDir', () => {
  it('环境变量覆盖优先级最高(dev 与打包版同)', () => {
    for (const isPackaged of [false, true]) {
      expect(
        pickOutputsDir({ envOverride: '/custom/out', isPackaged, cwd: '/repo', dataDir: '/home/u/.bigbotart', exists: exists([]) }),
      ).toBe('/custom/out');
    }
  });

  it('dev:仓库内已有产物目录优先(兼容历史 Take 视频)', () => {
    expect(
      pickOutputsDir({ isPackaged: false, cwd: '/repo', dataDir: '/home/u/.bigbotart', exists: exists([REPO_OUT, HOME_OUT]) }),
    ).toBe(REPO_OUT);
  });

  it('dev:仓库无产物目录时回落 DATA_DIR/outputs', () => {
    expect(
      pickOutputsDir({ isPackaged: false, cwd: '/repo', dataDir: '/home/u/.bigbotart', exists: exists([HOME_OUT]) }),
    ).toBe(HOME_OUT);
  });

  it('dev:全都不存在也返回 DATA_DIR/outputs(由调用方 mkdir)', () => {
    expect(
      pickOutputsDir({ isPackaged: false, cwd: '/repo', dataDir: '/home/u/.bigbotart', exists: exists([]) }),
    ).toBe(HOME_OUT);
  });

  it('打包版:绝不跟随 cwd —— 即使 cwd 下有产物目录也固定 DATA_DIR/outputs(事故回归)', () => {
    expect(
      pickOutputsDir({ isPackaged: true, cwd: '/repo', dataDir: '/home/u/.bigbotart', exists: exists([REPO_OUT, HOME_OUT]) }),
    ).toBe(HOME_OUT);
  });

  it('打包版:cwd=/ 时不受影响', () => {
    expect(
      pickOutputsDir({ isPackaged: true, cwd: '/', dataDir: '/home/u/.bigbotart', exists: exists([]) }),
    ).toBe(HOME_OUT);
  });
});
