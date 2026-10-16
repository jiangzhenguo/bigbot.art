/**
 * 硬编码颜色护栏 — 《深色浅色主题-产品设计与技术方案》§6.4
 *
 * 扫描 renderer/src 下 tsx/ts/css,禁止新增十六进制 / rgba 颜色字面量。
 * 颜色只能走 CSS 变量(public/design/colors_and_type.css)。
 * 白名单仅限 §6.1「语义与主题无关」的存量项(遮罩像素数据、文案占位符)。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, '../..');

/** 允许出现字面量的 (相对路径, 行内须包含的子串) —— 精确到行语义,不是整文件放行 */
const ALLOWLIST: Array<{ file: string; mustInclude: string; reason: string }> = [
  {
    file: 'pages/canvas/inspector/image-ui.tsx',
    mustInclude: "ctx.fillStyle = '#000'",
    reason: '遮罩 canvas 数据本身(黑=保留),非 UI 色',
  },
  {
    file: 'pages/canvas/inspector/image-ui.tsx',
    mustInclude: "ctx.fillStyle = '#fff'",
    reason: '遮罩 canvas 数据本身(白=重绘),非 UI 色',
  },
  {
    file: 'pages/canvas/inspector/InspectorBody.tsx',
    mustInclude: 'placeholder="white / #ffffff"',
    reason: '用户输入提示文案,不是样式',
  },
];

/** #rgb / #rrggbb / #rrggbbaa 与 rgba?/hsla? 字面量(不含 var(--…)) */
const COLOR_RE =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|(?:rgba?|hsla?)\(\s*[\d.]+/g;

const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.(test|spec)\.(tsx?|css)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(rel: string, line: string): boolean {
  return ALLOWLIST.some((a) => a.file === rel && line.includes(a.mustInclude));
}

describe('renderer 禁止新增硬编码颜色(§6.4)', () => {
  it('tsx/ts/css 中除白名单外不得出现 #hex / rgba / hsla 字面量', () => {
    const hits: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll('\\', '/');
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        // 跳过纯注释行里的示例(仍允许文案/数据白名单命中)
        if (/^\s*\/\//.test(line) && !isAllowed(rel, line)) return;
        COLOR_RE.lastIndex = 0;
        if (!COLOR_RE.test(line)) return;
        if (isAllowed(rel, line)) return;
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits, `发现未入白名单的硬编码色:\n${hits.join('\n')}`).toEqual([]);
  });

  it('白名单条目仍存在于源码(防止误删后护栏空转)', () => {
    for (const a of ALLOWLIST) {
      const src = readFileSync(resolve(SRC_ROOT, a.file), 'utf8');
      expect(src.includes(a.mustInclude), `白名单锚点丢失: ${a.file} · ${a.reason}`).toBe(true);
    }
  });
});
