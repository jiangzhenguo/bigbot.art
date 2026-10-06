/**
 * 媒体信息探测单测 —— 主进程 media-probe.ts
 *
 * 分两层:
 *  A. **纯函数**(必跑,不依赖环境):parseFps / parseProbeJson / kindByExt / probeLimit。
 *     喂进去的是**真实 ffprobe 输出片段**(从本机现跑的文件里抄下来的形态),
 *     不是凭空编的结构 —— 这样才挡得住「字段名记错」这类回归。
 *  B. **集成**(本机有 ffmpeg 才跑):用 ffmpeg 造图片/视频/音频,真实 ffprobe 走一遍,
 *     校验「图片有宽高无帧率」「视频有帧率」「音频有采样率」这三条最核心的语义。
 *
 * 关键:media-probe.ts 只依赖 fs/path(无模块级 env 求值),但仍沿用同目录约定动态 import,
 * 避免与其它测试的 env 设置互相干扰。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

let MP: typeof import('../media-probe.js');
beforeAll(async () => {
  MP = await import('../media-probe.js');
});

/* ════════════════ A. 纯函数 ════════════════ */

describe('parseFps — 帧率字符串解析', () => {
  it('整数分数 24/1 → 24', () => {
    expect(MP.parseFps('24/1')).toBe(24);
  });

  it('NTSC 非整数帧率保留两位小数(截断成 30 会误导)', () => {
    expect(MP.parseFps('30000/1001')).toBe(29.97);
    expect(MP.parseFps('24000/1001')).toBe(23.98);
  });

  it('裸数字字符串直接接受', () => {
    expect(MP.parseFps('25')).toBe(25);
  });

  it('0/0(未知)判 undefined,不能变成 0', () => {
    expect(MP.parseFps('0/0')).toBeUndefined();
  });

  it('分母为 0 判 undefined(不做除零)', () => {
    expect(MP.parseFps('24/0')).toBeUndefined();
  });

  it('空 / 缺失 / 负数 / 垃圾串一律 undefined', () => {
    expect(MP.parseFps(undefined)).toBeUndefined();
    expect(MP.parseFps(null)).toBeUndefined();
    expect(MP.parseFps('')).toBeUndefined();
    expect(MP.parseFps('-1/1')).toBeUndefined();
    expect(MP.parseFps('abc')).toBeUndefined();
  });
});

describe('parseProbeJson — 图片', () => {
  it('png:拿宽高与编码,不编造帧率/时长', () => {
    const info = MP.parseProbeJson(
      {
        streams: [{ codec_type: 'video', codec_name: 'png', width: 1024, height: 768 }],
        format: { format_name: 'png_pipe', size: '123456' },
      },
      'image',
      'a.png',
    );
    expect(info.ok).toBe(true);
    expect(info.width).toBe(1024);
    expect(info.height).toBe(768);
    expect(info.videoCodec).toBe('png');
    expect(info.fps).toBeUndefined();
    expect(info.durationSec).toBeUndefined();
  });

  /**
   * ⚠️ 真实数据回归(2026-09,用户资产库实测):
   * ffprobe 把 jpg 当「1 帧、25fps 的视频」,报出 `duration: 0.040000`
   * 与一个 19501 kbps 的「码率」。这两个值对一张静图完全无意义 ——
   * 时长若被当真写进 assets.json,时间线会把静图算成 0 秒片段。
   */
  it('jpg(ffprobe 谎报 0.04s 时长与高码率):两者都必须被清掉', () => {
    const info = MP.parseProbeJson(
      {
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mjpeg',
            width: 1410,
            height: 1066,
            avg_frame_rate: '25/1',
            r_frame_rate: '25/1',
            duration: '0.040000',
          },
        ],
        format: { format_name: 'image2', duration: '0.040000', bit_rate: '19501000' },
      },
      'image',
      'a.jpg',
    );
    expect(info.width).toBe(1410);
    expect(info.height).toBe(1066);
    expect(info.durationSec).toBeUndefined();
    expect(info.bitrateKbps).toBeUndefined();
    expect(info.fps).toBeUndefined();
  });

  it('时长为 0 / 负数一律判 undefined(静图与损坏文件都不能冒充合法时长)', () => {
    const zero = MP.parseProbeJson(
      { streams: [{ codec_type: 'video', width: 10, height: 10 }], format: { duration: '0' } },
      'image',
    );
    expect(zero.durationSec).toBeUndefined();
    const neg = MP.parseProbeJson(
      { streams: [{ codec_type: 'audio', sample_rate: '44100' }], format: { duration: '-1' } },
      'audio',
    );
    expect(neg.durationSec).toBeUndefined();
  });
});

describe('parseProbeJson — 视频', () => {
  /** 真实 h3 产物形态(864x480 / 24fps / 5.2s / 带 aac 音轨) */
  const h3Video = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 864,
        height: 480,
        avg_frame_rate: '24/1',
        r_frame_rate: '24/1',
        nb_frames: '124',
        duration: '5.175000',
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
        sample_rate: '32000',
        channels: 2,
        channel_layout: 'stereo',
      },
    ],
    format: { duration: '5.200000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', bit_rate: '1500000' },
  };

  it('时长/分辨率/帧率/帧数/编码/音轨全齐', () => {
    const info = MP.parseProbeJson(h3Video, 'video', 'take.mp4');
    expect(info.width).toBe(864);
    expect(info.height).toBe(480);
    // format.duration 优先于 stream.duration(容器总长才是用户看到的时长)
    expect(info.durationSec).toBe(5.2);
    expect(info.fps).toBe(24);
    expect(info.frameCount).toBe(124);
    expect(info.videoCodec).toBe('h264');
    expect(info.hasAudio).toBe(true);
    expect(info.audioCodec).toBe('aac');
    expect(info.sampleRate).toBe(32000);
    expect(info.channels).toBe(2);
    expect(info.channelLayout).toBe('stereo');
    expect(info.bitrateKbps).toBe(1500);
  });

  it('优先 avg_frame_rate:VFR 素材的 r_frame_rate 会虚高', () => {
    const info = MP.parseProbeJson(
      {
        streams: [{ codec_type: 'video', width: 100, height: 100, avg_frame_rate: '30/1', r_frame_rate: '30000/1001' }],
        format: { duration: '2' },
      },
      'video',
    );
    expect(info.fps).toBe(30);
  });

  it('avg_frame_rate 缺失(0/0)时回退 r_frame_rate', () => {
    const info = MP.parseProbeJson(
      {
        streams: [{ codec_type: 'video', width: 100, height: 100, avg_frame_rate: '0/0', r_frame_rate: '24/1' }],
        format: { duration: '2' },
      },
      'video',
    );
    expect(info.fps).toBe(24);
  });

  it('无声视频:hasAudio=false 而不是留空(下游据此判断要不要走截断分支)', () => {
    const info = MP.parseProbeJson(
      { streams: [{ codec_type: 'video', width: 64, height: 64, avg_frame_rate: '24/1' }], format: { duration: '1' } },
      'video',
    );
    expect(info.hasAudio).toBe(false);
    expect(info.audioCodec).toBeUndefined();
  });

  it('竖拍视频 rotate=90:宽高互换并记录旋转角', () => {
    const info = MP.parseProbeJson(
      {
        streams: [
          { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1', tags: { rotate: '90' } },
        ],
        format: { duration: '10' },
      },
      'video',
    );
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.rotation).toBe(90);
  });

  it('side_data rotation 与 tags.rotate 同口径', () => {
    const info = MP.parseProbeJson(
      { streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }] },
      'video',
    );
    // -90 归一化为 270,同样触发互换
    expect(info.rotation).toBe(270);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
  });

  it('rotate=0 不触发互换也不写 rotation 行', () => {
    const info = MP.parseProbeJson(
      { streams: [{ codec_type: 'video', width: 1920, height: 1080, tags: { rotate: '0' } }] },
      'video',
    );
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.rotation).toBeUndefined();
  });

  it('多视频流(带内嵌封面的 mp4)取第一条主轨', () => {
    const info = MP.parseProbeJson(
      {
        streams: [
          { codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '25/1' },
          { codec_type: 'video', width: 320, height: 240, codec_name: 'mjpeg' },
        ],
        format: { duration: '3' },
      },
      'video',
    );
    expect(info.width).toBe(1280);
  });

  it('nb_frames 非数字(部分容器填 N/A)时不写帧数', () => {
    const info = MP.parseProbeJson(
      { streams: [{ codec_type: 'video', width: 10, height: 10, nb_frames: 'N/A' }], format: { duration: '1' } },
      'video',
    );
    expect(info.frameCount).toBeUndefined();
  });
});

describe('parseProbeJson — 音频', () => {
  it('时长/采样率/声道/编码(wav 的 duration 只在 format 里)', () => {
    const info = MP.parseProbeJson(
      {
        streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '44100', channels: 1, channel_layout: 'mono' }],
        format: { duration: '12.345678', format_name: 'wav' },
      },
      'audio',
      'a.wav',
    );
    expect(info.durationSec).toBe(12.3);
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(1);
    expect(info.channelLayout).toBe('mono');
    expect(info.audioCodec).toBe('pcm_s16le');
    expect(info.container).toBe('wav');
  });

  it('音频不给画面字段(width/height/fps 全 undefined)', () => {
    const info = MP.parseProbeJson(
      { streams: [{ codec_type: 'audio', sample_rate: '48000', channels: 2 }], format: { duration: '1' } },
      'audio',
    );
    expect(info.width).toBeUndefined();
    expect(info.height).toBeUndefined();
    expect(info.fps).toBeUndefined();
  });

  it('format 与 stream 都没有 duration 时留 undefined(不填 0)', () => {
    const info = MP.parseProbeJson({ streams: [{ codec_type: 'audio', sample_rate: '48000' }] }, 'audio');
    expect(info.durationSec).toBeUndefined();
  });

  it('空 JSON(ffprobe 对损坏文件可能给空 streams)不炸', () => {
    const info = MP.parseProbeJson({}, 'audio');
    expect(info.ok).toBe(true);
    expect(info.durationSec).toBeUndefined();
  });
});

describe('parseProbeJson — document', () => {
  it('只给容器信息,不做媒体字段', () => {
    const info = MP.parseProbeJson({ format: { format_name: 'txt' } }, 'document', 'a.txt');
    expect(info.kind).toBe('document');
    expect(info.width).toBeUndefined();
    expect(info.fps).toBeUndefined();
  });
});

describe('kindByExt — 扩展名推断媒体类型', () => {
  it('常见图片/视频/音频扩展名', () => {
    expect(MP.kindByExt('/a/b.png')).toBe('image');
    expect(MP.kindByExt('/a/b.JPEG')).toBe('image');
    expect(MP.kindByExt('/a/b.mp4')).toBe('video');
    expect(MP.kindByExt('/a/b.MOV')).toBe('video');
    expect(MP.kindByExt('/a/b.mp3')).toBe('audio');
    expect(MP.kindByExt('/a/b.flac')).toBe('audio');
  });

  it('未知扩展名返回 null(由调用方决定怎么处理,不猜)', () => {
    expect(MP.kindByExt('/a/b.xyz')).toBeNull();
    expect(MP.kindByExt('/a/noext')).toBeNull();
  });
});

describe('probeLimit — 文件大小展示', () => {
  it('MB / GB 两种量级', () => {
    expect(MP.probeLimit(5 * 1024 * 1024).human).toBe('5.0 MB');
    expect(MP.probeLimit(2 * 1024 * 1024 * 1024).human).toBe('2.00 GB');
  });

  it('不因为文件大就拒绝探测(ffprobe 只读 metadata)', () => {
    expect(MP.probeLimit(10 * 1024 * 1024 * 1024).overLimit).toBe(false);
  });
});

/* ════════════════ B. 真实 ffprobe 集成 ════════════════ */

describe.skipIf(!hasFfmpeg)('probeMediaInfo — 真实 ffprobe 端到端', () => {
  let dir = '';
  let img = '';
  let vid = '';
  let aud = '';
  let vidNoAudio = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bbart-mediaprobe-'));
    img = join(dir, 'still.png');
    vid = join(dir, 'clip.mp4');
    aud = join(dir, 'tone.wav');
    vidNoAudio = join(dir, 'silent.mp4');

    // 400x300 静图
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=400x300:d=1', '-frames:v', '1', img]);
    // 320x240 / 25fps / 2s / 带正弦音轨(32000Hz 单声道)
    spawnSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vid,
    ]);
    // 同尺寸静音视频(无音轨)
    spawnSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', vidNoAudio,
    ]);
    // 44100Hz 单声道 wav / 1.5s
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=1.5', aud]);
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });

  it('图片:宽高准确,不产生帧率/时长', async () => {
    const info = await MP.probeMediaInfo(img, 'image');
    expect(info.ok).toBe(true);
    expect(info.width).toBe(400);
    expect(info.height).toBe(300);
    expect(info.fps).toBeUndefined();
    expect(info.durationSec).toBeUndefined();
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  it('视频:时长/分辨率/帧率/帧数/音轨采样率全部拿到', async () => {
    const info = await MP.probeMediaInfo(vid, 'video');
    expect(info.ok).toBe(true);
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.fps).toBe(25);
    expect(info.durationSec).toBeGreaterThan(1.8);
    expect(info.durationSec).toBeLessThan(2.5);
    expect(info.frameCount).toBeGreaterThanOrEqual(45);
    expect(info.videoCodec).toBe('h264');
    expect(info.hasAudio).toBe(true);
    expect(info.audioCodec).toBe('aac');
    expect(info.sampleRate).toBe(32000);
    expect(info.channels).toBe(1);
  });

  it('静音视频:hasAudio=false(下游据此判断参考视频会不会带声音)', async () => {
    const info = await MP.probeMediaInfo(vidNoAudio, 'video');
    expect(info.ok).toBe(true);
    expect(info.hasAudio).toBe(false);
    expect(info.fps).toBe(15);
    expect(info.width).toBe(160);
  });

  it('音频:时长/采样率/声道', async () => {
    const info = await MP.probeMediaInfo(aud, 'audio');
    expect(info.ok).toBe(true);
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(1);
    expect(info.durationSec).toBeGreaterThan(1.4);
    expect(info.durationSec).toBeLessThan(1.7);
    expect(info.width).toBeUndefined();
  });

  it('不传 kind 时按扩展名推断', async () => {
    const info = await MP.probeMediaInfo(vid);
    expect(info.kind).toBe('video');
    expect(info.fps).toBe(25);
  });
});

describe('probeMediaInfo — 失败面(不依赖 ffmpeg)', () => {
  it('文件不存在:ok=false 且错误里带路径', async () => {
    const info = await MP.probeMediaInfo('/definitely/not/here/nope.mp4', 'video');
    expect(info.ok).toBe(false);
    expect(info.error).toContain('文件不存在');
  });

  it('空路径:明确报错而不是抛异常', async () => {
    const info = await MP.probeMediaInfo('', 'image');
    expect(info.ok).toBe(false);
    expect(info.error).toBeTruthy();
  });

  it('传目录:报「不是常规文件」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbart-mediaprobe-dir-'));
    try {
      const info = await MP.probeMediaInfo(dir, 'image');
      expect(info.ok).toBe(false);
      expect(info.error).toContain('不是常规文件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('0 字节文件:报「文件为空」而不是让 ffprobe 报一堆 stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbart-mediaprobe-empty-'));
    const f = join(dir, 'empty.mp4');
    try {
      mkdirSync(dir, { recursive: true });
      spawnSync('touch', [f]);
      expect(existsSync(f)).toBe(true);
      const info = await MP.probeMediaInfo(f, 'video');
      expect(info.ok).toBe(false);
      expect(info.error).toContain('文件为空');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏文件:ok=false 带 ffprobe 报错尾部(不是静默空结果)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbart-mediaprobe-bad-'));
    const f = join(dir, 'broken.mp4');
    try {
      spawnSync('bash', ['-c', `printf 'not a real video at all' > ${JSON.stringify(f)}`]);
      const info = await MP.probeMediaInfo(f, 'video');
      expect(info.ok).toBe(false);
      expect(info.error).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
