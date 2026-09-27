/**
 * rangeFileResponse 单测 — 锁住「自定义协议必须支持 Range」这条回归线。
 *
 * 背景(2026-09 真实事故):`bba-asset://` / `bba-output://` 原先用 `net.fetch('file://…')` 返回文件,
 * 响应**不带 accept-ranges / content-length,且完全忽略 Range 头**(永远回 200 整个文件)。
 * 浏览器据此判定资源不可定位 → `<video>.seekable` 恒为 `[0,0]` → 视频能顺序播放但进度条拖不动。
 * 修复后必须保证:200 带 accept-ranges、Range 命中回 206 + content-range、非法区间回 416。
 *
 * 这些用例在真实 Electron 里已手工验证过(seekable 由 [0,0] 变 [0,片长])。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ⚠️ 先于 assets 模块加载:该模块顶层按 BIGBOTART_HOME 求值 ASSETS_DIR / OUTPUTS_DIR,
// 必须指向临时目录,绝不触碰真实用户数据(与 frames-crop.test.ts 同约定)
const tmpHome = mkdtempSync(join(tmpdir(), 'bba-range-home-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const { rangeFileResponse } = await import('../assets');

let dir = '';
let file = '';
/** 64 字节可预测内容:第 i 字节 = i */
const SIZE = 64;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bba-range-'));
  file = join(dir, 'sample.mp4');
  writeFileSync(file, Buffer.from(Array.from({ length: SIZE }, (_, i) => i)));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 读全 body(测试文件很小,可整块读) */
async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/** 把响应 body 读干并吞掉可能的流错误 —— 未消费的 body 会在删临时目录后才被 GC 读流,
 *  触发 ENOENT unhandled error 污染测试输出(即使断言全过) */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* 故意忽略:只为把流消费掉 */
  }
}

describe('rangeFileResponse', () => {
  it('无 Range:200 + accept-ranges + content-length + 正确 MIME,body 是完整文件', async () => {
    const res = rangeFileResponse(file, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const b = await bodyBytes(res);
    expect(b.length).toBe(SIZE);
    expect(b[0]).toBe(0);
    expect(b[SIZE - 1]).toBe(SIZE - 1);
  });

  it('Range bytes=0-9:206 + content-range,只回前 10 字节', async () => {
    const res = rangeFileResponse(file, 'bytes=0-9');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-9/${SIZE}`);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const b = await bodyBytes(res);
    expect(b.length).toBe(10);
    expect(b[0]).toBe(0);
    expect(b[9]).toBe(9);
  });

  it('Range bytes=10-19:偏移正确(不是从 0 开始)', async () => {
    const res = rangeFileResponse(file, 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${SIZE}`);
    const b = await bodyBytes(res);
    expect(b.length).toBe(10);
    expect(b[0]).toBe(10);
    expect(b[9]).toBe(19);
  });

  it('Range bytes=start-(开区间):回 start 到文件末尾', async () => {
    const res = rangeFileResponse(file, 'bytes=60-');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 60-63/${SIZE}`);
    const b = await bodyBytes(res);
    expect(b.length).toBe(4);
    expect(b[0]).toBe(60);
  });

  it('Range bytes=-10(后缀区间):末尾 10 字节', async () => {
    const res = rangeFileResponse(file, 'bytes=-10');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 54-63/${SIZE}`);
    const b = await bodyBytes(res);
    expect(b.length).toBe(10);
    expect(b[0]).toBe(54);
  });

  it('Range 上界超出文件:截到文件末尾,不越界', async () => {
    const res = rangeFileResponse(file, `bytes=60-9999`);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 60-63/${SIZE}`);
    expect((await bodyBytes(res)).length).toBe(4);
  });

  it('start >= size:416 + content-range 通配', async () => {
    const res = rangeFileResponse(file, `bytes=${SIZE}-`);
    await drain(res);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('非法 Range 语法:416(不当作整文件返回)', async () => {
    for (const bad of ['bytes=abc', 'items=0-1', 'bytes=0-1-2', 'bytes=']) {
      const res = rangeFileResponse(file, bad);
      await drain(res);
      expect(res.status, `bad header: ${bad}`).toBe(416);
    }
  });

  it('文件不存在:404', async () => {
    const res = rangeFileResponse(join(dir, 'nope.mp4'), null);
    await drain(res);
    expect(res.status).toBe(404);
  });

  it('未知扩展名回退 application/octet-stream', async () => {
    const f2 = join(dir, 'x.bin');
    writeFileSync(f2, Buffer.from([1, 2, 3]));
    const res = rangeFileResponse(f2, null);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe('3');
    await drain(res);
  });

  it('content-length 与真实文件大小一致(126MB 级大文件的 seek 依赖它)', async () => {
    const res = rangeFileResponse(file, null);
    expect(Number(res.headers.get('content-length'))).toBe(statSync(file).size);
    await drain(res);
  });
});
