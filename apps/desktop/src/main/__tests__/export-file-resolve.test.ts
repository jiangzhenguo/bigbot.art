/**
 * bba-output:// 文件名校验(isValidOutputRelName)+ 导出成片解析(resolveExportFile)单测。
 *
 * 真实事故(2026-10):时间线节点成片预览整块黑屏 —— 导出文件名由项目名派生
 * (sanitizeOutputName 保留中文),而 bba-output 协议处理器的白名单正则
 * `/^[A-Za-z0-9._/-]+$/` 不认中文,直接 400。锁这条回归线。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ⚠️ 先于 assets/export 模块加载:两者顶层按 BIGBOTART_HOME 求值目录常量,
// 必须指向临时目录,绝不触碰真实用户数据(与 range-file-response.test.ts 同约定)
const tmpHome = mkdtempSync(join(tmpdir(), 'bba-output-name-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const { isValidOutputRelName } = await import('../assets');
const { resolveExportFile } = await import('../export');

const EXPORT_DIR = join(tmpHome, 'exports');

describe('isValidOutputRelName', () => {
  it('中文文件名合法(事故回归:飞机1-xxx.mp4 曾被 400 拒成黑屏)', () => {
    expect(isValidOutputRelName('飞机1-1791721354091-wz5g.mp4')).toBe(true);
    expect(isValidOutputRelName('机翼对决_全片合并版-1791710435236-pbhu.mp4')).toBe(true);
  });

  it('常规相对路径与子目录合法', () => {
    expect(isValidOutputRelName('timeline-1.mp4')).toBe(true);
    expect(isValidOutputRelName('mock/shot-1.mp4')).toBe(true);
    expect(isValidOutputRelName('images/gen-1.png')).toBe(true);
  });

  it('路径穿越 / 绝对路径 / 反斜杠 / 盘符冒号 / 控制字符 / 空串一律拒绝', () => {
    expect(isValidOutputRelName('')).toBe(false);
    expect(isValidOutputRelName('../secret.mp4')).toBe(false);
    expect(isValidOutputRelName('a/../../b.mp4')).toBe(false);
    expect(isValidOutputRelName('/etc/passwd')).toBe(false);
    expect(isValidOutputRelName('a\\b.mp4')).toBe(false);
    expect(isValidOutputRelName('C:/x.mp4')).toBe(false);
    expect(isValidOutputRelName('a\nb.mp4')).toBe(false);
    expect(isValidOutputRelName('a\x00b.mp4')).toBe(false);
  });
});

describe('resolveExportFile', () => {
  beforeAll(() => {
    mkdirSync(EXPORT_DIR, { recursive: true });
    writeFileSync(join(EXPORT_DIR, '飞机1-x.mp4'), 'fake');
  });
  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('按文件名解析出导出目录内的成片(含中文名)', () => {
    expect(resolveExportFile('飞机1-x.mp4')).toBe(join(EXPORT_DIR, '飞机1-x.mp4'));
  });

  it('文件不存在 / 空名一律 null(调用方给「成片不存在」人话)', () => {
    expect(resolveExportFile('nope.mp4')).toBeNull();
    expect(resolveExportFile('')).toBeNull();
    expect(resolveExportFile(undefined)).toBeNull();
  });

  it('只认 basename:任何输入都剥成纯文件名后在 EXPORT_DIR 内解析(天然防穿越)', () => {
    // basename 命中导出目录内的文件 → 解析成功(目录部分一律丢弃,故 `..` 无从生效)
    expect(resolveExportFile('../exports/飞机1-x.mp4')).toBe(join(EXPORT_DIR, '飞机1-x.mp4'));
    expect(resolveExportFile(join(EXPORT_DIR, '飞机1-x.mp4'))).toBe(join(EXPORT_DIR, '飞机1-x.mp4'));
    // 外来目录的文件即使真实存在也不会被带出(basename 在导出目录内不存在 → null)
    const outside = join(tmpHome, 'outside.mp4');
    writeFileSync(outside, 'fake');
    expect(resolveExportFile(outside)).toBeNull();
  });
});
