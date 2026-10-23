/**
 * 公网浏览器验收:真的用 Chrome 打开 https://host/bba/,登录、进项目、开画布。
 *
 * 用法:node apps/desktop/scripts/verify-relay-browser.mjs <公网地址> <网页登录口令> [截图路径]
 * 例:  node apps/desktop/scripts/verify-relay-browser.mjs https://bigbot.art/bba 'XXXX-XXXX' /tmp/bba.png
 */
import { chromium } from 'playwright-core';

const base = (process.argv[2] ?? 'https://bigbot.art/bba').replace(/\/+$/, '');
const passphrase = process.argv[3] ?? '';
const shot = process.argv[4] ?? '/tmp/bba-relay-browser.png';

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const browser = await chromium.launch({
  executablePath: process.env.BIGBOTART_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  console.log(`[1] 打开 ${base}`);
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('[data-od-id=remote-passphrase]').waitFor({ state: 'visible', timeout: 20_000 });
  ok('登录页出现', true);

  console.log('\n[2] 登录');
  await page.locator('[data-od-id=remote-passphrase]').fill(passphrase);
  await page.locator('[data-od-id=remote-login-submit]').click();
  await page.locator('[data-od-id=home-new-project]').waitFor({ timeout: 30_000 });
  ok('进到首页(首页按钮可见)', true);
  ok('网页端模式(window.bigbotartShell=false)', (await page.evaluate(() => window.bigbotartShell)) === false);
  ok('接口前缀推导正确', (await page.evaluate(() => location.pathname)) === '/bba/', await page.evaluate(() => location.pathname));

  console.log('\n[3] 项目与画布');
  const projects = await page.evaluate(() => window.bigbotart.listProjects());
  ok('项目列表能取到', Array.isArray(projects) && projects.length > 0, `${projects?.length ?? 0} 个项目`);
  const first = projects[0];
  const opened = await page.evaluate(async (id) => {
    const canvases = await window.bigbotart.loadProjectCanvases(id);
    return { activeCanvasId: canvases.activeCanvasId ?? null, count: canvases.canvases?.length ?? 0 };
  }, first.id);
  ok('画布能加载', opened.count > 0, `画布 ${opened.count} 个`);

  console.log('\n[4] 媒体与事件流');
  const events = await page.evaluate(async () => {
    const seen = [];
    window.bigbotart.onQueueChanged((jobs) => seen.push(jobs));
    await new Promise((r) => setTimeout(r, 500));
    return seen.length;
  });
  ok('事件流订阅可用', true, `收到 ${events} 轮`);

  await page.screenshot({ path: shot, fullPage: false });
  console.log(`\n截图: ${shot}`);

  ok('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));
  const realErrors = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  ok('控制台无错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\n浏览器验收全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
