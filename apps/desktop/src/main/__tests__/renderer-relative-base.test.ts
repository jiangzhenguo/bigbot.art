/**
 * 护栏:渲染层必须以**相对 base** 构建。
 *
 * 网页端跑在公网域名的路径前缀下(例如 https://host/bba/)。
 * 静态资源是相对引用(./assets/…)时,由文档自己的 URL 解析,
 * 才会跟着落到 /bba/assets/…,与接口前缀一致。
 * 一旦 base 变成绝对路径('/'),资源会跑到根路径,
 * 结果是「页面能打开但全白、接口也 404」——很难一眼看出原因,
 * 所以在这里钉死。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('渲染层相对 base', () => {
  it('vite 配置写死 base: "./"', () => {
    const cfg = readFileSync(resolve('apps/desktop/electron.vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/base:\s*['"]\.\/['"]/);
  });

  it('构建产物的资源引用不带根路径(有产物时校验)', () => {
    const html = resolve('apps/desktop/out/renderer/index.html');
    if (!existsSync(html)) return; // 没构建过就跳过,不制造假失败
    const text = readFileSync(html, 'utf8');
    const absolute = [...text.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
    expect(absolute).toEqual([]);
  });
});
