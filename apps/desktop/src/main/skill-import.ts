/**
 * 从本地技能包解析出可入库的草稿。
 * 选择的是一个文件夹或 .zip:根目录(或 zip 解出来的那一层)放 SKILL.md / skill.json。
 * 根目录没有入口、但子文件夹各有一份时,每个子文件夹算一个技能。
 * 单个 Markdown / JSON 的解析仍保留,给包内的入口文件用。
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export interface SkillImportDraft {
  name: string;
  description?: string;
  instructions: string;
  inject: 'full' | 'summary';
  /** frontmatter 里写明的占位;正文里的 {占位} 由 SkillStore 再补 */
  params: string[];
  nodes: unknown[];
  edges: unknown[];
}

export type SkillParseResult =
  | { ok: true; draft: SkillImportDraft }
  | { ok: false; error: string };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).trim();
  return t;
}

function readFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (!key || value == null) continue;
    out[key.toLowerCase()] = unquote(value);
  }
  return out;
}

function splitParams(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，]/)
    .map((p) => p.trim().replace(/^\{/, '').replace(/\}$/, ''))
    .filter(Boolean)
    .map((p) => `{${p}}`);
}

function asInject(raw: string | undefined): 'full' | 'summary' {
  return raw === 'summary' ? 'summary' : 'full';
}

function draftOf(input: {
  name: string;
  description?: string;
  instructions: string;
  inject?: string;
  params?: string[];
  nodes?: unknown;
  edges?: unknown;
}): SkillParseResult {
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  if (!name) return { ok: false, error: '技能文档缺少名称(frontmatter 的 name,或文件名)' };
  if (!instructions && nodes.length === 0) return { ok: false, error: '这份文件没有操作指令,也没有画布模板' };
  return {
    ok: true,
    draft: {
      name,
      description: input.description?.trim() || undefined,
      instructions,
      inject: asInject(input.inject),
      params: input.params ?? [],
      nodes,
      edges,
    },
  };
}

function parseJsonSkill(raw: string, fallbackName: string): SkillParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON' };
  }
  if (Array.isArray(data)) return { ok: false, error: '请选择单个技能文件,不是技能库清单' };
  if (!data || typeof data !== 'object') return { ok: false, error: '技能 JSON 必须是一个对象' };
  const o = data as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name : fallbackName;
  const instructions =
    typeof o.instructions === 'string'
      ? o.instructions
      : typeof o.markdown === 'string'
        ? o.markdown
        : '';
  const description = typeof o.description === 'string' ? o.description : typeof o.desc === 'string' ? o.desc : undefined;
  const inject = typeof o.inject === 'string' ? o.inject : undefined;
  const params = Array.isArray(o.params) ? o.params.filter((p): p is string => typeof p === 'string') : [];
  return draftOf({ name, description, instructions, inject, params, nodes: o.nodes, edges: o.edges });
}

/** 解析一份技能文档。fallbackName 一般是去掉扩展名的文件名。 */
export function parseSkillDocument(raw: string, fallbackName: string): SkillParseResult {
  const text = raw.replace(/^\uFEFF/, '');
  if (text.includes('\0')) return { ok: false, error: '文件不是文本' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '文件是空的' };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonSkill(trimmed, fallbackName);
  const fm = FRONTMATTER.exec(text);
  if (!fm) {
    return draftOf({ name: fallbackName, instructions: text });
  }
  const head = fm[1];
  const whole = fm[0];
  if (head == null || whole == null) return draftOf({ name: fallbackName, instructions: text });
  const meta = readFrontmatter(head);
  const body = text.slice(whole.length);
  return draftOf({
    name: meta.name || fallbackName,
    description: meta.desc || meta.description,
    instructions: body,
    inject: meta.inject,
    params: splitParams(meta.params),
  });
}

export interface SkillPackageFile {
  /** 包内相对路径,用 / 分隔,不含 .. */
  rel: string;
  text: string;
}

export type SkillPackageResult =
  | { ok: true; drafts: SkillImportDraft[] }
  | { ok: false; error: string };

const TEXT_EXT = /\.(md|markdown|json|txt)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', '__macosx']);
const MAX_TEXT = 512 * 1024;
const MAX_ZIP = 32 * 1024 * 1024;
const MAX_FILES = 200;

/** 去掉危险路径和 macOS 垃圾目录。 */
export function normalizePackageRel(rel: string): string | null {
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || p.includes('\0'))) return null;
  if (parts[0]?.toLowerCase() === '__macosx') return null;
  if (parts.some((p) => p.startsWith('._'))) return null;
  return parts.join('/');
}

function stripSingleRoot(files: SkillPackageFile[]): { files: SkillPackageFile[]; strippedName: string | null } {
  const tops = new Set(files.map((f) => f.rel.split('/')[0] ?? ''));
  if (tops.size !== 1) return { files, strippedName: null };
  const top = [...tops][0];
  if (!top) return { files, strippedName: null };
  if (!files.every((f) => f.rel.startsWith(`${top}/`))) return { files, strippedName: null };
  return {
    strippedName: top,
    files: files.map((f) => ({ rel: f.rel.slice(top.length + 1), text: f.text })).filter((f) => f.rel.length > 0),
  };
}

function chooseEntry(names: string[]): string | null {
  const byLower = new Map<string, string>();
  for (const n of names) byLower.set(n.toLowerCase(), n);
  for (const want of ['skill.md', 'skill.json', 'index.md']) {
    const hit = byLower.get(want);
    if (hit) return hit;
  }
  const mds = names.filter((n) => /\.(md|markdown)$/i.test(n));
  if (mds.length === 1) return mds[0] ?? null;
  return null;
}

interface SkillRoot {
  /** 该技能目录下的文件,rel 相对该目录 */
  files: Array<{ name: string; text: string }>;
  fallbackName: string;
}

function rootsOf(files: SkillPackageFile[], packageName: string): SkillRoot[] {
  const topNames = files.filter((f) => !f.rel.includes('/')).map((f) => f.rel);
  if (chooseEntry(topNames)) {
    return [{
      fallbackName: packageName,
      files: files.filter((f) => !f.rel.includes('/')).map((f) => ({ name: f.rel, text: f.text })),
    }];
  }
  const groups = new Map<string, Array<{ name: string; text: string }>>();
  for (const f of files) {
    const slash = f.rel.indexOf('/');
    if (slash < 0) continue;
    const dir = f.rel.slice(0, slash);
    const name = f.rel.slice(slash + 1);
    if (!dir || !name || name.includes('/')) continue;
    const list = groups.get(dir) ?? [];
    list.push({ name, text: f.text });
    groups.set(dir, list);
  }
  const roots: SkillRoot[] = [];
  for (const [dir, list] of groups) {
    if (chooseEntry(list.map((f) => f.name))) roots.push({ fallbackName: dir, files: list });
  }
  return roots;
}

/** 从一个技能包的文件清单里找出要入库的技能。 */
export function skillDraftsFromPackage(files: SkillPackageFile[], packageName: string): SkillPackageResult {
  const cleaned: SkillPackageFile[] = [];
  for (const f of files) {
    const rel = normalizePackageRel(f.rel);
    if (!rel || !TEXT_EXT.test(rel)) continue;
    cleaned.push({ rel, text: f.text });
  }
  const stripped = stripSingleRoot(cleaned);
  const roots = rootsOf(stripped.files, stripped.strippedName || packageName);
  if (roots.length === 0) {
    return { ok: false, error: '这里没有技能文档。请在文件夹根目录放 SKILL.md 或 skill.json,或每个子文件夹各放一份' };
  }
  const drafts: SkillImportDraft[] = [];
  const errors: string[] = [];
  for (const root of roots) {
    const entryName = chooseEntry(root.files.map((f) => f.name));
    const entry = entryName ? root.files.find((f) => f.name === entryName) : undefined;
    if (!entry) {
      errors.push(root.fallbackName);
      continue;
    }
    const parsed = parseSkillDocument(entry.text, root.fallbackName);
    if (!parsed.ok) {
      errors.push(`${root.fallbackName}: ${parsed.error}`);
      continue;
    }
    drafts.push(parsed.draft);
  }
  if (drafts.length === 0) {
    return { ok: false, error: errors.length ? `没能导入:${errors.join('；')}` : '这里没有技能文档' };
  }
  return { ok: true, drafts };
}

function readSkillTree(root: string): SkillPackageFile[] {
  const out: SkillPackageFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > 3) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('._')) continue;
      if (SKIP_DIR.has(name.toLowerCase())) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile() || !TEXT_EXT.test(name) || st.size > MAX_TEXT || st.size === 0) continue;
      out.push({ rel: relative(root, abs).split(sep).join('/'), text: readFileSync(abs, 'utf8') });
      if (out.length >= MAX_FILES) return;
    }
  };
  walk(root, 0);
  return out;
}

function run(cmd: string, args: string[], maxStdout: number): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxStdout) chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ code: -1, stdout: Buffer.concat(chunks), stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }));
  });
}

async function readZipEntries(zipPath: string): Promise<SkillPackageFile[] | { error: string }> {
  const listed = await run('unzip', ['-Z1', '--', zipPath], 1_000_000);
  if (listed.code === -1) return { error: '本机没有 unzip,无法读取 zip 包' };
  if (listed.code !== 0) return { error: `无法读取 zip:${listed.stderr.trim() || 'unzip 失败'}` };
  const names = listed.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (names.length > 2000) return { error: 'zip 里的文件太多' };
  const out: SkillPackageFile[] = [];
  for (const name of names) {
    const rel = normalizePackageRel(name);
    if (!rel || rel.endsWith('/') || !TEXT_EXT.test(rel)) continue;
    if (name.startsWith('-')) return { error: 'zip 里有不安全的路径' };
    const got = await run('unzip', ['-p', '--', zipPath, name], MAX_TEXT + 1);
    if (got.code !== 0) return { error: `无法读取 zip 内的 ${rel}` };
    if (got.stdout.length > MAX_TEXT) continue;
    out.push({ rel, text: got.stdout.toString('utf8') });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/** 读一个技能文件夹或 .zip 包。 */
export async function loadSkillPackage(targetPath: string): Promise<SkillPackageResult> {
  let st;
  try {
    st = statSync(targetPath);
  } catch (e) {
    return { ok: false, error: `找不到:${(e as Error).message}` };
  }
  const packageName = basename(targetPath).replace(/\.zip$/i, '') || '导入的技能';
  if (st.isDirectory()) return skillDraftsFromPackage(readSkillTree(targetPath), packageName);
  if (st.isFile() && targetPath.toLowerCase().endsWith('.zip')) {
    if (st.size > MAX_ZIP) return { ok: false, error: 'zip 超过 32MB' };
    const files = await readZipEntries(targetPath);
    if (!Array.isArray(files)) return { ok: false, error: files.error };
    return skillDraftsFromPackage(files, packageName);
  }
  return { ok: false, error: '请选择技能文件夹或 .zip 包' };
}
