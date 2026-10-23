/**
 * dry-run 冒烟:无头浏览器登录、打开项目/画布、提交 mock 任务并收到进度。
 *
 * 默认不跑。它要已构建的渲染层、系统 Chrome,并且会拉起主进程模块。
 * BIGBOTART_REMOTE_SMOKE=1 pnpm exec vitest run apps/desktop/src/main/__tests__/remote-smoke.test.ts
 *
 * 只绑 127.0.0.1(BIGBOTART_REMOTE_LOOPBACK=1),不碰真实推理。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dialogCalls = vi.hoisted(() => ({ open: 0, save: 0, reveal: 0 }));

vi.mock('electron', async () => {
  const actual = await import('./electron-stub');
  return {
    ...actual,
    app: {
      ...actual.app,
      isPackaged: false,
      whenReady: () => new Promise(() => {}),
    },
    dialog: {
      showOpenDialog: async () => {
        dialogCalls.open += 1;
        return { canceled: true, filePaths: [] };
      },
      showSaveDialog: async () => {
        dialogCalls.save += 1;
        return { canceled: true, filePath: undefined };
      },
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: {
      ...actual.shell,
      showItemInFolder: () => {
        dialogCalls.reveal += 1;
      },
    },
  };
});

const enabled = process.env.BIGBOTART_REMOTE_SMOKE === '1';
const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

describe.skipIf(!enabled)('远程访问 dry-run 冒烟', () => {
  it('浏览器能登录、打开画布、提交 mock 并收到队列进度', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bba-remote-smoke-'));
    homes.push(home);
    const port = await freePort();
    const staticDir = resolve('apps/desktop/out/renderer');
    process.env.BIGBOTART_HOME = home;
    process.env.BIGBOTART_H3_OUTPUTS = join(home, 'outputs');
    process.env.BIGBOTART_DRYRUN = '1';
    process.env.BIGBOTART_REMOTE_LOOPBACK = '1';
    process.env.BIGBOTART_REMOTE_STATIC = staticDir;
    mkdirSync(home, { recursive: true });
    const { rotatePassphrase } = await import('../remote/auth');
    const passphrase = rotatePassphrase(home);
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        renderMode: 'demo',
        language: 'zh-CN',
        remoteAccess: { enabled: true, port },
      }),
    );
    await import('../index');

    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${base}/session`);
        if (res.status === 401 || res.status === 200) {
          up = true;
          break;
        }
      } catch {
        /* 还在 bind */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(up, '远程服务没有在回环上起来').toBe(true);

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: process.env.BIGBOTART_CHROME || '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-od-id=remote-passphrase]').fill(passphrase);
      await page.locator('[data-od-id=remote-login-submit]').click();
      await page.locator('[data-od-id=home-new-project]').waitFor({ timeout: 20_000 });
      const shell = await page.evaluate(() => window.bigbotartShell);
      expect(shell).toBe(false);

      await page.locator('[data-od-id=home-new-project]').click();
      await page.getByPlaceholder('项目名称，如：草原之河 · 短剧').fill('冒烟项目');
      await page.getByRole('button', { name: '创建项目' }).click();
      await page.locator('[data-od-id=canvas-stage]').waitFor({ timeout: 30_000 });

      const progress = await page.evaluate(async () => {
        const projects = await window.bigbotart.listProjects();
        const project = projects.find((p) => p.name === '冒烟项目');
        if (!project) throw new Error('项目列表里没有冒烟项目');
        const canvases = await window.bigbotart.loadProjectCanvases(project.id);
        const canvasId = canvases.activeCanvasId ?? canvases.canvases[0]?.id;
        if (!canvasId) throw new Error('项目没有画布');
        const events: unknown[] = [];
        window.bigbotart.onQueueChanged((jobs) => events.push(jobs));
        await window.bigbotart.submitRender({
          provider: 'mock',
          nodeId: 'smoke-node',
          slot: 'image',
          projectId: project.id,
          canvasId,
          params: { prompt: 'dry-run smoke' },
        });
        const start = Date.now();
        while (events.length === 0 && Date.now() - start < 15_000) {
          await new Promise((r) => setTimeout(r, 100));
        }
        return { projectId: project.id, canvasId, count: events.length, first: events[0] ?? null };
      });
      expect(progress.projectId).toBeTruthy();
      expect(progress.canvasId).toBeTruthy();
      expect(progress.count).toBeGreaterThan(0);

      const denied = await page.evaluate(async () => {
        try {
          await window.bigbotart.uploadProjectCover('nope');
          return 'called';
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      });
      expect(denied).toContain('远程不支持系统对话框');
      expect(dialogCalls.open).toBe(0);
      expect(dialogCalls.reveal).toBe(0);
      expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
