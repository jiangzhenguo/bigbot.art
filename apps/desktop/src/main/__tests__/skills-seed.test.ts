/**
 * SkillStore 内置技能种子合并 + tombstone 单测(主进程 skills.ts)
 * - 空库首次构造:seed 全部内置技能
 * - 已有库再次构造:合并官方新增的内置 id(按 id 去重),不动用户技能
 * - 内置技能被 delete → 记 tombstone,重新构造不复活
 *
 * 关键:skills.ts 的 DATA_DIR 在 import 时按 BIGBOTART_HOME 求值 →
 * 模块顶层先设临时目录,再在 beforeAll 里动态 import(绝不触碰真实 ~/.bigbotart)。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-skills-test-'));
process.env.BIGBOTART_HOME = tmpHome;

const SKILLS_FILE = join(tmpHome, 'skills.json');
const TOMBSTONE_FILE = join(tmpHome, 'skills-builtin-deleted.json');

let M: typeof import('../skills.js');

/**
 * 历史出厂版正文(2026-10-09 之前的初版,10132 字,无 h3 参考图能力表)。
 * 取自 git 历史,指纹 `fnv1a-37793bcf-10132` 与生产代码 LEGACY_BUILTIN_FINGERPRINTS 登记的一致 ——
 * 这正是「老用户库里那份内容」的真实形态,用它验证升级路径最有说服力。
 */
const LEGACY_TEXT = readFileSync(
  join(__dirname, 'fixtures', '3d-animation-short.legacy-v1.md'),
  'utf-8',
);

beforeAll(async () => {
  M = await import('../skills.js');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('SkillStore 内置技能种子', () => {
  it('空库首次构造 → seed 全部内置技能(builtin:true)', () => {
    const store = new M.SkillStore();
    const builtins = store.list().filter((s) => s.builtin);
    expect(builtins.length).toBeGreaterThanOrEqual(9); // MiniMax 官方适配技能
    expect(builtins.some((s) => s.id === 'h3-prompt-writing')).toBe(true);
    expect(builtins.some((s) => s.id === 'paper-collage')).toBe(false); // 已退役
    expect(existsSync(SKILLS_FILE)).toBe(true);
  });

  it('已有库再次构造 → 合并不存在的内置 id,用户技能原样保留', () => {
    // 模拟老版本库:只剩一个用户技能 + 一个仍在服役的内置技能(其余内置被"官方扩容"新增)
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: 'skill-user-1',
          name: '我的技能',
          nodes: [],
          edges: [],
          params: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'h3-prompt-writing',
          name: 'H3 提示词写作规范',
          nodes: [],
          edges: [],
          params: [],
          instructions: '旧内容不被覆盖',
          builtin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    const list = store.list();
    // 用户技能保留
    expect(list.some((s) => s.id === 'skill-user-1')).toBe(true);
    // 缺失的内置技能被合并进来
    expect(list.some((s) => s.id === 'minimalist-product-ad' && s.builtin)).toBe(true);
    // 已存在的内置技能内容不被种子覆盖
    expect(store.get('h3-prompt-writing')?.instructions).toBe('旧内容不被覆盖');
  });

  it('删除内置技能 → 记 tombstone,重新构造不复活;删用户技能不记', () => {
    const store = new M.SkillStore();
    expect(store.delete('minimalist-product-ad').ok).toBe(true);
    expect(store.delete('skill-user-1').ok).toBe(true);
    const tombstones = JSON.parse(readFileSync(TOMBSTONE_FILE, 'utf-8')) as string[];
    expect(tombstones).toContain('minimalist-product-ad');
    expect(tombstones).not.toContain('skill-user-1');

    const store2 = new M.SkillStore();
    expect(store2.get('minimalist-product-ad')).toBeUndefined(); // tombstone 挡住复活
    expect(store2.get('h3-prompt-writing')).toBeDefined(); // 未删的内置仍在
  });

  it('全部删空后重新构造 → 内置技能全部 tombstone,不复活任何一个', () => {
    const store = new M.SkillStore();
    for (const s of store.list()) store.delete(s.id);
    const store2 = new M.SkillStore();
    const ids = store2.list().map((s) => s.id);
    expect(ids).toHaveLength(0); // 所有内置均被用户删过(tombstone),空库也不再复活
    expect(ids).not.toContain('minimalist-product-ad');
  });

  it('退役内置(纸拼贴/电商/科普)启动时从库清除并记 tombstone', () => {
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: 'paper-collage',
          name: '纸拼贴剧情片',
          nodes: [],
          edges: [],
          params: [],
          instructions: '应被清掉',
          builtin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'ecom-product',
          name: '电商产品',
          nodes: [],
          edges: [],
          params: [],
          instructions: '应被清掉',
          builtin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'science-pop',
          name: '科普讲解',
          nodes: [],
          edges: [],
          params: [],
          instructions: '应被清掉',
          builtin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'skill-user-keep',
          name: '我的技能',
          nodes: [],
          edges: [],
          params: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    expect(store.get('paper-collage')).toBeUndefined();
    expect(store.get('ecom-product')).toBeUndefined();
    expect(store.get('science-pop')).toBeUndefined();
    expect(store.get('skill-user-keep')).toBeDefined();
    const tombstones = JSON.parse(readFileSync(TOMBSTONE_FILE, 'utf-8')) as string[];
    expect(tombstones).toEqual(expect.arrayContaining(['paper-collage', 'ecom-product', 'science-pop']));
  });
});

/**
 * 内置技能的**正文/inject 升级**(2026-10-09 事故修复)
 *
 * 事故链(两次都踩在同一处):
 *   ① 3d-animation-short 是 summary 注入 → Agent 只看到前 160 字流程名,
 *      不知道「角色卡是权威身份源」,也**从未调用 skills.read**,直接从分镜表跳到铺节点;
 *   ② 把技能改成 full、并补写 h3 参考图能力表后重启 —— **库里还是旧内容**,
 *      因为种子合并「只补缺失、从不更新已有技能」。
 *      实测:源文件从 10132 字改到 13177 字,库里的还是 10132 字,新内容一条没进去。
 *
 * 修法:引入 builtinFingerprint(出厂正文指纹)+ 历史指纹白名单,
 * 区分「用户没编辑过(可安全升级)」与「用户改过(一律不动)」。
 */
describe('SkillStore 内置技能正文升级', () => {
  /**
   * ⚠️ 本组用例必须**清掉 tombstone** 再跑:上面的「全部删空」用例会把所有内置技能
   * 记进 tombstone(共享同一个 tmpHome),不清的话这里构造 Store 一个内置都拿不到。
   * 这属于测试间的状态污染 —— 显式在 beforeEach 里复位,而不是依赖用例执行顺序。
   */
  beforeEach(() => {
    rmSync(TOMBSTONE_FILE, { force: true });
  });

  it('出厂 3d-animation-short 是 full(事故技能不能退回 summary)', () => {
    const store = new M.SkillStore();
    // 3D 短片的核心价值就是角色/场景一致性,规则在中段 → 必须全量注入才看得到
    expect(store.get('3d-animation-short')?.inject).toBe('full');
  });

  it('co-op-game-intro 主菜单静帧走编辑模型锁 16:9(技能2测试事故)', () => {
    const store = new M.SkillStore();
    const ins = store.get('co-op-game-intro')?.instructions ?? '';
    expect(store.get('co-op-game-intro')?.inject).toBe('full');
    expect(ins).toContain('image-edit');
    expect(ins).toContain('Qwen/Qwen-Image-2.1');
    expect(ins).toContain('width=1024');
    expect(ins).toContain('height=576');
    expect(ins).toContain('禁止**把主菜单建成 `image-gen`');
    // 历史出厂版必须在白名单里,否则用户库(无 fingerprint 的旧正文)升不上来
    expect(M.isLegacyBuiltinFingerprint('fnv1a-3c5b8bf8-20704')).toBe(true);
    expect(M.isLegacyBuiltinFingerprint('fnv1a-bbcf1b5f-21952')).toBe(true);
    expect(M.isLegacyBuiltinFingerprint('fnv1a-837b6798-22777')).toBe(true);
    expect(ins).toContain('全身正面');
    expect(ins).toContain('image-edit');
  });

  it('handdrawn-live-video 全量注入并锁关联生成(技能4事故)', () => {
    const store = new M.SkillStore();
    const ins = store.get('handdrawn-live-video')?.instructions ?? '';
    expect(store.get('handdrawn-live-video')?.inject).toBe('full');
    expect(ins).toContain('mode=ref-image');
    expect(ins).toContain('禁止首帧 + 参考图混连');
    expect(ins).toContain('label: "ref-image"');
    expect(M.isLegacyBuiltinFingerprint('fnv1a-b7db5dd6-3486')).toBe(true);
  });

  it('出厂正文含 h3 参考图能力表(事故修复内容确实在种子文件里)', () => {
    const store = new M.SkillStore();
    const ins = store.get('3d-animation-short')?.instructions ?? '';
    // 这三条是本次修复的核心,缺任何一个都会退回事故状态
    expect(ins).toContain('最多 9 张'); // 纠正「只能 1 张」的错误认知
    expect(ins).toContain('逐镜模式选择'); // 方案③ 按镜二选一
    expect(ins).toContain('modeOverride'); // 防止模式被自动推导覆盖
    expect(ins).toContain('全身正面');
    expect(ins).toContain('有参考图');
    expect(M.isLegacyBuiltinFingerprint('fnv1a-289805d7-17333')).toBe(true);
  });

  it('新 seed 的技能带 builtinFingerprint', () => {
    const store = new M.SkillStore();
    expect(store.get('3d-animation-short')?.builtinFingerprint).toBeTruthy();
  });

  it('老库(无 fingerprint)但正文 = 历史出厂版 → **安全升级**为新版正文', () => {
    /* 这是本次事故的真实形态:库里没有 fingerprint 字段(字段是新引入的),
       正文是旧版出厂内容(10132 字)。若不认历史白名单,这种库永远拿不到修复。 */
    const seed = new M.SkillStore().get('3d-animation-short')!;
    // 前置确认:这份 fixture 确实是「历史出厂版」(指纹在白名单里)
    expect(M.isLegacyBuiltinFingerprint(M.fingerprintText(LEGACY_TEXT))).toBe(true);
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: '3d-animation-short',
          name: seed.name,
          nodes: [],
          edges: [],
          params: [],
          instructions: LEGACY_TEXT, // 旧版出厂正文(无 fingerprint 字段)
          inject: 'summary', // 旧值
          builtin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    const s = store.get('3d-animation-short');
    expect(s?.instructions).toBe(seed.instructions); // 正文已升级到最新
    expect(s?.instructions).toContain('最多 9 张'); // 修复内容真的进来了
    expect(s?.inject).toBe('full'); // inject 一并跟随
    expect(s?.builtinFingerprint).toBeTruthy(); // 补上指纹,后续可继续升级
  });

  it('有 fingerprint 且正文吻合 → 升级为新版正文', () => {
    const seed = new M.SkillStore().get('3d-animation-short')!;
    const oldText = '旧版出厂正文(模拟)';
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: '3d-animation-short',
          name: seed.name,
          nodes: [],
          edges: [],
          params: [],
          instructions: oldText,
          inject: 'summary',
          builtin: true,
          builtinFingerprint: M.fingerprintText(oldText), // 指纹吻合 ⇒ 没编辑过
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    expect(store.get('3d-animation-short')?.instructions).toBe(seed.instructions);
    expect(store.get('3d-animation-short')?.inject).toBe('full');
  });

  it('用户编辑过正文(fingerprint 不吻合)→ **一字不动**,inject 也听用户的', () => {
    const userText = '这是用户自己改写的指令正文,与出厂内容完全不同';
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: '3d-animation-short',
          name: '我改过的技能',
          nodes: [],
          edges: [],
          params: [],
          instructions: userText,
          inject: 'summary', // 用户有意保持 summary
          builtin: true,
          builtinFingerprint: M.fingerprintText('某一版出厂正文,已被用户改掉'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    const s = store.get('3d-animation-short');
    expect(s?.instructions).toBe(userText); // 正文未被覆盖
    expect(s?.inject).toBe('summary'); // inject 也不被顶掉
  });

  it('来源不明(无指纹且不命中白名单)→ 保守不动,绝不覆盖', () => {
    const mystery = '来路不明的正文,既不是已知出厂版,也没有指纹';
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: '3d-animation-short',
          name: 'x',
          nodes: [],
          edges: [],
          params: [],
          instructions: mystery,
          inject: 'summary',
          builtin: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    expect(store.get('3d-animation-short')?.instructions).toBe(mystery);
  });

  it('用户自建技能(builtin 非 true)永不被升级波及', () => {
    writeFileSync(
      SKILLS_FILE,
      JSON.stringify([
        {
          id: 'my-own',
          name: '用户技能',
          nodes: [],
          edges: [],
          params: [],
          instructions: '自定义',
          inject: 'summary',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new M.SkillStore();
    expect(store.get('my-own')?.inject).toBe('summary');
    expect(store.get('my-own')?.instructions).toBe('自定义');
  });
});

/**
 * 用 update() 编辑内置技能后,指纹必须被清掉 —— 否则下次启动升级会覆盖用户编辑。
 * 这是「保护用户编辑」这条承诺的承重点。
 */
describe('SkillStore.update 清掉指纹(保护用户编辑)', () => {
  beforeEach(() => {
    rmSync(TOMBSTONE_FILE, { force: true });
    rmSync(SKILLS_FILE, { force: true });
  });

  it('改了正文 → builtinFingerprint 被清空', () => {
    const store = new M.SkillStore();
    const before = store.get('3d-animation-short')!;
    expect(before.builtinFingerprint).toBeTruthy();
    store.update('3d-animation-short', { instructions: '我自己的版本' });
    expect(store.get('3d-animation-short')?.builtinFingerprint).toBeUndefined();
  });

  it('改过之后重启 → 编辑内容不被出厂正文覆盖', () => {
    const store = new M.SkillStore();
    store.update('3d-animation-short', { instructions: '我自己的版本' });
    const store2 = new M.SkillStore(); // 模拟重启
    expect(store2.get('3d-animation-short')?.instructions).toBe('我自己的版本');
  });

  it('只改 inject 也算「用户已介入」→ 清指纹,不被出厂值顶掉', () => {
    const store = new M.SkillStore();
    store.update('3d-animation-short', { inject: 'summary' });
    expect(store.get('3d-animation-short')?.builtinFingerprint).toBeUndefined();
    const store2 = new M.SkillStore();
    expect(store2.get('3d-animation-short')?.inject).toBe('summary');
  });
});
