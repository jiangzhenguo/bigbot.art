/**
 * 本地看图通道 **真跑** 端到端(opt-in,默认跳过)
 *
 * 为什么要一个「默认跳过」的真跑用例:本项目的红线是「不假成功」,而这条通道的
 * 关键风险恰恰只有真跑才暴露 —— 命令解析(shebang 回退)、checkpoint 判族、
 * 引擎 spawn、`--output` 回读,任一环断了单测(注入假 runner)都会绿。
 *
 * 启用方式(需要本机已有一份 MLX 格式 Qwen3-VL checkpoint):
 *   BIGBOTART_CAPTION_E2E=1 pnpm vitest run apps/desktop/src/main/__tests__/mlxgen-caption-e2e.test.ts
 * 可选:`BIGBOTART_CAPTION_MODEL=<checkpoint 目录>` 指定模型;不指定则走自动发现。
 * 实测成本(本机 M5 Pro / 64GB,8B 4bit checkpoint):单张 640x480 约 15-25 秒,峰值内存 ~6GB。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENABLED = process.env.BIGBOTART_CAPTION_E2E === '1';

let vision: typeof import('../vision.js');
let captionLocal: typeof import('../mlxgen-caption.js');
let home: string;

beforeAll(async () => {
  if (!ENABLED) return;
  // 隔离:图片放在临时 HOME 的产物目录里(白名单允许),绝不碰真实用户数据(R5)
  home = mkdtempSync(join(tmpdir(), 'bba-caption-e2e-'));
  process.env.BIGBOTART_HOME = home;
  const out = join(home, 'outputs', 'images');
  mkdirSync(out, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', join(out, 'probe.png')], {
    stdio: 'ignore',
  });
  vision = await import('../vision.js');
  captionLocal = await import('../mlxgen-caption.js');
});

describe.skipIf(!ENABLED)('mlxgen-caption 真跑(opt-in)', () => {
  it('本机命令可解析(console script 或 shebang 回退),且能真反推出一段文本', async () => {
    const probe = await captionLocal.probeLocalCaption(process.env);
    expect(probe.available, `本地 caption 通道不可用:${JSON.stringify(probe)}`).toBe(true);

    const res = await vision.captionImage(join(home, 'outputs', 'images', 'probe.png'), 'prompt');
    expect(res.ok, res.error).toBe(true);
    expect(res.backend).toBe('mlxgen');
    expect((res.caption ?? '').trim().length).toBeGreaterThan(5);
    // ⚠️ 语言回归(2026-10-12 用户反馈「反推出来的都是英文」):默认风格必须出**中文**。
    // 指令写死中文还不够 —— 得真跑一次证明模型照做了。
    const cjk = (res.caption ?? '').match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    expect(cjk, `默认风格必须输出中文,实际输出:\n${res.caption}`).toBeGreaterThan(20);
    // eslint-disable-next-line no-console
    console.log(`[e2e] 命令=${probe.command}\n[e2e] 通道=${res.backend} 模型=${res.model} 文本长度=${res.caption?.length}:\n${res.caption}`);
  }, 600_000);

  it('MlxgenCaption 的产物落盘路径可清理(不残留临时目录)', async () => {
    const cfg = await captionLocal.resolveCaptionConfig(process.env);
    expect(cfg).toBeTruthy();
    const res = await captionLocal.runMlxgenCaption(cfg!, join(home, 'outputs', 'images', 'probe.png'), 'one sentence');
    expect(res.ok, res.error).toBe(true);
  }, 600_000);

  /* 最后一环:Agent 真正走的入口(tool handler)也必须落到本地通道 —— 单测里那条路径是 fetch 打桩的,
     只有真跑才能证明「模型在 App 里调用 vision.caption 时拿到的是本地引擎的结果」。 */
  it('tool handler 全链路:asset 节点 → 本地引擎 → 工具文本回显通道名', async () => {
    const { ToolHandlers } = await import('../tool-handlers.js');
    const img = join(home, 'outputs', 'images', 'probe.png');
    const store = {
      loadProjectCanvases: () => ({
        projectId: 'p-e2e',
        canvases: [
          {
            id: 'c-e2e',
            name: '探针画布',
            version: 1,
            nodes: [{ id: 'n1', kind: 'asset', label: '探针图', position: { x: 0, y: 0 }, data: { assetId: 'a1' } }],
            edges: [],
            groups: [],
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    } as never;
    const assets = { get: (id: string) => (id === 'a1' ? { id: 'a1', name: 'probe.png', localPath: img } : undefined) } as never;
    const h = new ToolHandlers(store, assets, {} as never, {} as never, {} as never, {} as never);
    const r = await h.call('vision.caption', { nodeId: 'n1', style: 'prompt' }, { projectId: 'p-e2e', canvasId: 'c-e2e' });
    expect(r.ok, r.result).toBe(true);
    expect(r.result).toContain('mlxgen-caption'); // 工具文本必须说明用的是哪条通道
    expect(r.result).toContain('探针图');
  }, 600_000);

  /* ⚠️ 真实事故回归(2026-10-12):设置页里填的是 **LM Studio 的模型名**
     (`qwen3-vl-8b-nsfw-caption-v4.5-affine`)。这里用真机环境复现该绑定,
     要求「解析出真目录」并且「真能出文本」—— 光靠单测的假树不算数。 */
  it('设置页填 LM Studio 模型名(裸名字)→ 解析到真目录并真反推成功', async () => {
    const r = await captionLocal.resolveCaptionConfigDetailed(process.env, {
      model: 'qwen3-vl-8b-nsfw-caption-v4.5-affine',
    });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.config.model).toContain('Qwen3-VL-8B-NSFW-Caption-V4.5-affine'); // 反查到真目录,而不是把裸名字丢给引擎
    const res = await captionLocal.runMlxgenCaption(
      r.config,
      join(home, 'outputs', 'images', 'probe.png'),
      'Describe this image in one sentence.',
    );
    expect(res.ok, res.error).toBe(true);
    expect((res.caption ?? '').trim().length).toBeGreaterThan(5);
    // eslint-disable-next-line no-console
    console.log(`[e2e] 裸模型名 → ${r.config.model}\n${res.caption}`);
  }, 600_000);

  it('cleanup', () => {
    if (home) rmSync(home, { recursive: true, force: true });
  });
});
