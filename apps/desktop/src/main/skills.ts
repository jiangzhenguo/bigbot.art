/**
 * SkillStore — Skills 库(PRD §5.5 P0 基础)
 * - 保存:把项目画布(节点结构 + 参数 + 提示词模板)深拷贝为 Skill
 * - 应用:Skill 克隆到新项目画布(换新 id 实体化),返回新项目
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Skill, CanvasNode, CanvasEdge, Project } from '@bigbotart/shared';
import { applyParamValuesDeep } from '@bigbotart/shared';
import type { SkillImportDraft } from './skill-import';
import type { ProjectStore } from './store';
// MiniMax 官方技能(MiniMax-AI/MiniMax-H3,适配为 BigBotArt 工具流程后的指令文档,?raw 打进 main 包)
import h3PromptWriting from './builtin-skills/h3-prompt-writing.md?raw';
import paperCollageExplainer from './builtin-skills/paper-collage-explainer.md?raw';
import papercraftStopMotion from './builtin-skills/papercraft-stop-motion.md?raw';
import animation3dShort from './builtin-skills/3d-animation-short.md?raw';
import brandPromoVideo from './builtin-skills/brand-promo-video.md?raw';
import minimalistProductAd from './builtin-skills/minimalist-product-ad.md?raw';
import handdrawnLiveVideo from './builtin-skills/handdrawn-live-video.md?raw';
import musicVideoSubtitle from './builtin-skills/music-video-subtitle.md?raw';
import coOpGameIntro from './builtin-skills/co-op-game-intro.md?raw';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
const SKILLS_FILE = join(DATA_DIR, 'skills.json');
/** 用户删除过的内置技能 id 名单(防止种子合并时复活) */
const BUILTIN_TOMBSTONE_FILE = join(DATA_DIR, 'skills-builtin-deleted.json');

/** 从节点数据里收集参数占位,如 {主题} {旁白} {时长} */
export function collectParams(nodes: CanvasNode[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{([^{}]{1,20})\}/g)) out.add(`{${m[1]}}`);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  nodes.forEach((n) => walk(n.data));
  return [...out];
}

/**
 * 已退役的内置技能 id(2026-10-16:纸拼贴剧情片 / 电商产品 / 科普讲解)。
 * 启动时从已有库清掉并写入 tombstone,避免老用户库残留、也防止误复活。
 * 用户自建同名技能(无 builtin / 不同 id)不受影响。
 */
const RETIRED_BUILTIN_IDS = new Set<string>(['paper-collage', 'ecom-product', 'science-pop']);

/**
 * 官方精选出厂技能(MiniMax 官方技能适配版;源:github.com/MiniMax-AI/MiniMax-H3 skills/)。
 * 仅在 skills.json 首次创建时 seed(builtin:true);用户删除后不再自动复活。
 * 大文件一律 inject:'summary'(注入摘要 + skills.read 按需取全文),个别技能因核心规则在中后段必须 full。
 */
const BUILTIN_SKILLS: Array<{ id: string; name: string; description: string; instructions: string; inject?: 'full' | 'summary' }> = [
  {
    id: 'h3-prompt-writing',
    name: 'H3 提示词写作规范',
    description: 'MiniMax 官方:T2VA/I2VA/FL2VA/L2VA/Ref2VA 五种模式的 H3 视频提示词结构规范(含完整附录)',
    instructions: h3PromptWriting,
    inject: 'summary',
  },
  {
    id: 'paper-collage-explainer',
    name: '纸拼贴讲解动画生成器',
    description: 'MiniMax 官方:基于文案或抽象概念,完成隐喻设计、拼贴分镜和动画生成,适用于讲解类内容',
    instructions: paperCollageExplainer,
    inject: 'summary',
  },
  {
    id: 'papercraft-stop-motion',
    name: '纸艺定格科普视频生成器',
    description: 'MiniMax 官方:根据知识主题,完成纸偶、分层布景、分镜与提示词设计,输出纸艺定格科普视频创作包',
    instructions: papercraftStopMotion,
    inject: 'summary',
  },
  {
    id: '3d-animation-short',
    name: '3D动画短片生成器',
    description: 'MiniMax 官方:根据故事创意,完成人物与场景设定、镜头规划、分镜生成和视频合成',
    instructions: animation3dShort,
    /* ⚠️ 必须是 full(2026-10-09 由 summary 改)。
     * 本技能的核心是**角色/场景一致性**,而这条规则写在文档中段
     * (「角色卡为权威身份源,场景卡为权威环境源」),summary 模式只注入前 160 字 =
     * 只有「项目简报 → 故事大纲 → 角色卡 → 场景卡 → …」这串流程名,规则一条都看不到。
     * 真实事故(「测试1」画布):Agent 激活本技能后**从未调用 skills.read**(recall 里 0 次),
     * 于是完全不知道角色卡是必需的,直接从分镜表跳到铺节点,8 个镜头的角色各画各的、
     * 毫无一致性可言 —— 用户看到的正是「拆分镜头后并没有生成人物参考图」。
     * 代价:约 +4k token systemPrompt(10k 字文档);换来的是流程不再被跳过,
     * 与该技能「角色一致」的核心价值相比是划算的(同批其他技能仍保持 summary)。 */
    inject: 'full',
  },
  {
    id: 'brand-promo-video',
    name: '品牌宣传短片生成器',
    description: 'MiniMax 官方:基于品牌素材与推广目标,完成事实核验、创意方向、分镜和音画合成',
    instructions: brandPromoVideo,
    inject: 'summary',
  },
  {
    id: 'minimalist-product-ad',
    name: '极简产品广告生成器',
    description: 'MiniMax 官方:基于产品图片和广告需求,完成卖点提炼、英文文案与节拍分镜设计,适用于电商推广',
    instructions: minimalistProductAd,
    /* ⚠️ 必须是 full(2026-10-14 由 summary 改,同 music-video-subtitle)。
     * 「产品本体保真 / 有真实产品图禁止 image-gen 重画 / 单 shot 连续片 + preview 先行」
     * 都写在中后段,summary 只见流程名。「技能5测试」实跑:Agent 用 image-gen 重新画了
     * 用户的产品当首帧、3 镜闭眼连跑(还因双触发各跑了 2 遍)。 */
    inject: 'full',
  },
  {
    id: 'handdrawn-live-video',
    name: '手绘实拍融合视频生成器',
    description: 'MiniMax 官方:基于场景创意,生成手绘动画与实拍接触变形的 15 秒创意短片',
    instructions: handdrawnLiveVideo,
    /* ⚠️ 必须是 full(2026-10-13「技能4」)。
     * summary 前 160 字看不到「全部 ref-image、禁止 first-frame」;
     * 实跑把环境图连成首帧、角色卡连成参考图,h3 报
     * full references cannot be combined with frame anchors,界面 mode 停在首帧。 */
    inject: 'full',
  },
  {
    id: 'music-video-subtitle',
    name: '音乐MV动态字幕生成器',
    description: 'MiniMax 官方:基于音乐和歌词,完成节奏拆解、镜头设计与动态字幕方案,适用于 AI MV 创作',
    instructions: musicVideoSubtitle,
    /* ⚠️ 必须是 full(2026-10-13)。
     * 核心硬规矩「用户音乐必须连 shot.ref-audio,只写 prompt 不算用了音乐」若用 summary,
     * 前 160 字只见适用场景,Agent 会跳过入库与连线直接文生视频 —— 用户反馈「没使用音乐生成视频」。
     * 工具层另有 checkMasterAudioGate 硬拦,文档全量注入是第一道防线。 */
    inject: 'full',
  },
  {
    id: 'co-op-game-intro',
    name: '双人游戏开场视频生成器',
    description: 'MiniMax 官方:根据玩家信息、角色参考图和视觉风格,完成首图确认与界面动效设计',
    instructions: coOpGameIntro,
    /* ⚠️ 必须是 full(2026-10-12 由 summary 改,同 3d-animation-short)。
     * 真实事故「测试技能2」:summary 只见「先静帧再视频」流程名,Agent 跳过 PLAYER 角色卡、
     * 把一张主菜单静帧当唯一参考、7 镜 mode 停在文生并行提交 → 人物锁不住、成片接不齐。
     * 核心规则(角色卡先行 / 1 静帧+1 镜头 / mode=ref-image /
     * 主菜单静帧走 image-edit+Qwen-Image-2.1 锁 16:9)写在正文前段,必须全量注入。 */
    inject: 'full',
  },
];

/** 官方精选出厂版本(seed 时写入;更新时间固定为初始化时刻) */
function builtinSeed(): Skill[] {
  const now = new Date().toISOString();
  return BUILTIN_SKILLS.map((b) => ({
    id: b.id,
    name: b.name,
    nodes: [],
    edges: [],
    params: collectParams([{ data: { markdown: b.instructions } } as CanvasNode]),
    description: b.description,
    instructions: b.instructions,
    inject: b.inject ?? 'full',
    builtin: true,
    // 出厂指纹:记录「出厂那一版正文」,供后续启动判断用户是否编辑过
    builtinFingerprint: fingerprintText(b.instructions),
    createdAt: now,
    updatedAt: now,
  }));
}

function readTombstones(): Set<string> {
  if (!existsSync(BUILTIN_TOMBSTONE_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(BUILTIN_TOMBSTONE_FILE, 'utf-8')) as string[]);
  } catch {
    return new Set();
  }
}

/**
 * 出厂正文指纹(内容哈希)。
 *
 * 只用于判断「当前 instructions 是否仍是出厂那一版」,不需要密码学强度 ——
 * 一个稳定的 32 位 FNV-1a 足够(碰撞概率对「十几个技能的正文比对」可忽略,
 * 且即便碰撞也只会导致一次不该发生的覆盖,后果可控)。
 * 不引 crypto 是为了让这段逻辑零依赖、可在渲染层/测试里直接复用。
 */
export function fingerprintText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16)}-${text.length}`;
}

/**
 * **历史出厂版本**的正文指纹白名单(迁移用)。
 *
 * 为什么需要它:builtinFingerprint 是本次(2026-10-09)才引入的字段,
 * 之前所有用户的库里都没有 —— 若只认指纹,老用户会被判成「无法判断是否编辑过」
 * 而**永远拿不到出厂正文升级**,修复等于对新老用户割裂。
 *
 * 做法:把历次出厂正文的指纹登记在这里。启动合并时,只要当前正文的指纹
 * 命中白名单中**任何一个**(= 内容逐字等于某一个历史出厂版),就判定「用户没编辑过」,
 * 安全升级到最新版;不命中才认为用户改过,一律不动。
 *
 * ⚠️ 维护约定:**每次改动 builtin-skills/*.md 后,把被替换掉的那一版指纹追加到这里**
 * (用 fingerprintText 算,或跑单测让它告诉你该填什么)。漏加不会导致数据损坏,
 * 只会让「没编辑过的老用户」停留在旧版正文 —— 但那就正是本次事故的形态,务必别漏。
 */
const LEGACY_BUILTIN_FINGERPRINTS = new Set<string>([
  // 3d-animation-short:2026-10-09 之前的初版(10132 字,无 h3 参考图能力表)
  'fnv1a-37793bcf-10132',
  // 3d-animation-short:2026-10-09 第一次修订(13177 字,有参考图能力表 + 逐镜模式选择,
  // 但标签段只有笼统的 face/hair/outfit,且未写「开场不留白」规则)
  'fnv1a-893dbe89-13177',
  // 3d-animation-short:2026-10-09 第二次修订(14588 字,加了 traits + 开场不留白,
  // 但仍是自造段名;未写「逐字抄角色卡 Visual ID」硬规则)
  'fnv1a-dafca940-14588',
  // 3d-animation-short:2026-10-09 第三次修订(16322 字,官方六段结构 + 逐字抄规则,
  // 但未写「提交即收尾 vs 多步流程」的关系 → Agent 会卡在「等出图」)
  'fnv1a-a90fae91-16322',
  // 3d-animation-short:2026-10-22 之前(17333 字)。角色卡写死 image-gen + 主 3/4 视角,
  // 未写「有参考图→image-edit / 无参考→image-gen」与默认全身正面。
  'fnv1a-289805d7-17333',
  // co-op-game-intro:初版(20704 字,主菜单是「先出一张静帧」,无角色卡硬门)
  'fnv1a-3c5b8bf8-20704',
  // co-op-game-intro:2026-10-12 角色卡先行修订(21952 字)。主菜单仍写 image-gen+ref-image,
  // 实跑落到 Klein 多参考,竖版角色卡把 16:9 请求改写成 800×1168。
  'fnv1a-bbcf1b5f-21952',
  // co-op-game-intro:2026-10-22 之前(22777 字)。角色卡一律 image-gen + 半身/¾,
  // 有上传图也只作 ref-image 重绘,未改为 image-edit 底图编辑 + 默认全身正面。
  'fnv1a-837b6798-22777',
  // music-video-subtitle:初版(7829 字,只在文案谈 Master Audio、未强制 ref-audio 连线)
  'fnv1a-16230625-7829',
  // handdrawn-live-video:2026-10-13 之前(3486 字)。只写「可先做 image-gen 首帧」,
  // 没锁 mode=ref-image,Agent 把环境图连成 first-frame、角色卡连成 ref-image。
  'fnv1a-b7db5dd6-3486',
  // minimalist-product-ad:2026-10-14 之前(8013 字)。锚定图/分镜静帧写死走 image-gen,
  // 没有「有真实产品图 → 一律 image-edit 以原图为底图」分流 ——
  // 「技能5测试」事故:用户传了键盘实拍图,Agent 却用 image-gen 重新画了一把键盘当首帧,
  // 成片里的产品不是用户的产品。
  'fnv1a-f9eda624-8013',
]);

/** 导出供单测断言「历史版本识别」行为(生产代码不应改动它) */
export function isLegacyBuiltinFingerprint(fp: string): boolean {
  return LEGACY_BUILTIN_FINGERPRINTS.has(fp);
}

export class SkillStore {
  private skills: Skill[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    const tombstones = readTombstones();
    // 退役内置:一次性从库中清掉 + 记 tombstone(老用户升级后不再看到)
    let retiredTouched = false;
    for (const id of RETIRED_BUILTIN_IDS) {
      if (!tombstones.has(id)) {
        tombstones.add(id);
        retiredTouched = true;
      }
    }
    if (retiredTouched) {
      writeFileSync(BUILTIN_TOMBSTONE_FILE, JSON.stringify([...tombstones], null, 2));
    }
    const seeds = builtinSeed().filter((b) => !tombstones.has(b.id));
    const existingRaw = this.read();
    const existing = existingRaw.filter((s) => !(s.builtin && RETIRED_BUILTIN_IDS.has(s.id)));
    const retiredFromLib = existingRaw.length - existing.length;
    if (existing.length === 0) {
      // 首次创建 或 空库(从未保存过)时 seed 官方精选(builtin)
      writeFileSync(SKILLS_FILE, JSON.stringify(seeds, null, 2));
      this.skills = seeds;
    } else {
      // 已有技能库:合并官方新增的内置技能(按 id 去重;用户删除过的在 tombstone 里,不复活)
      const have = new Set(existing.map((s) => s.id));
      const missing = seeds.filter((b) => !have.has(b.id));
      /* 🆕 内置技能正文升级(2026-10-09 事故修复)。
       *
       * 问题:种子合并此前**只补缺失**,已存在的内置技能原样保留 ——
       * 于是修好出厂正文(如 3D 短片的 h3 参考图能力表)对**老用户完全无效**:
       * 源文件改对了、应用也重启了,skills.json 里还是旧内容。实测踩中:
       * 改完 3D 技能后重启,库里仍是 10132 字的旧文,新写的「最多 9 张」一条都没进去。
       *
       * 判据用 **builtinFingerprint** + 历史指纹白名单,而不是「与当前出厂正文比对」:
       *   - 当前正文指纹 == builtinFingerprint,或命中 LEGACY_BUILTIN_FINGERPRINTS
       *     ⇒ 内容逐字等于某一版出厂正文 ⇒ 用户没编辑过 ⇒ **安全升级**;
       *   - 否则 ⇒ 用户编辑过 / 来源不明 ⇒ **正文一字不动**。
       *
       * 为什么不能直接「与当前出厂正文比对」:出厂内容一升级,比对必然不等,
       * 会把所有「没编辑过的老用户」误判成「编辑过」而永远失去更新 —— 正是本次事故形态。 */
      const byId = new Map(seeds.map((b) => [b.id, b]));
      let updated = 0;
      const merged = existing.map((s) => {
        if (!s.builtin) return s; // 用户自建技能一律不动
        const seed = byId.get(s.id);
        if (!seed) return s;
        const fp = s.builtinFingerprint;
        const curFp = fingerprintText(s.instructions ?? '');
        /* 「用户没动过正文」的两个充分条件:
           ① 有 fingerprint 且与当前正文吻合(本次之后新建/升级过的库);
           ② 当前正文命中**历史出厂指纹白名单**(本次之前建的库,没有 fingerprint 字段)。
           两者都不满足 ⇒ 视为用户编辑过 / 内容来源不明 ⇒ 一律不覆盖。 */
        const untouched = (!!fp && curFp === fp) || LEGACY_BUILTIN_FINGERPRINTS.has(curFp);
        if (!untouched) {
          /* 用户编辑过正文,或内容与任何已知出厂版都不符(来源不明)。
             两种情况的共同处置:**不碰正文**。区别只在 inject ——
             有 fingerprint 说明是我们管理过的库,用户既然可能改过,就听他的;
             没有 fingerprint 且不命中白名单,同样保守不动。 */
          return s;
        }
        // 用户没动过 → 把出厂正文/inject/描述升级到最新版
        const changed =
          s.instructions !== seed.instructions ||
          (s.inject ?? 'full') !== seed.inject ||
          s.description !== seed.description;
        if (!changed) return s;
        updated += 1;
        return {
          ...s,
          instructions: seed.instructions,
          inject: seed.inject,
          description: seed.description,
          params: seed.params,
          builtinFingerprint: fingerprintText(seed.instructions ?? ''),
          updatedAt: new Date().toISOString(),
        };
      });
      this.skills = missing.length ? [...merged, ...missing] : merged;
      if (missing.length || updated || retiredFromLib) this.persist();
    }
  }

  private read(): Skill[] {
    if (!existsSync(SKILLS_FILE)) return [];
    try {
      return JSON.parse(readFileSync(SKILLS_FILE, 'utf-8')) as Skill[];
    } catch {
      return [];
    }
  }

  private persist() {
    writeFileSync(SKILLS_FILE, JSON.stringify(this.skills, null, 2));
  }

  list(): Skill[] {
    return [...this.skills].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  get(id: string): Skill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  delete(id: string): { ok: boolean; error?: string } {
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx < 0) return { ok: false, error: 'Skill 不存在' };
    const [removed] = this.skills.splice(idx, 1);
    // 内置技能被用户删除 → 记 tombstone,下次启动的种子合并不再复活它
    if (removed?.builtin) {
      const tombstones = readTombstones();
      tombstones.add(id);
      writeFileSync(BUILTIN_TOMBSTONE_FILE, JSON.stringify([...tombstones], null, 2));
    }
    this.persist();
    return { ok: true };
  }

  /** 🆕 更新技能元信息/指令段(指令编辑器用;不动画布模板 nodes/edges) */
  update(id: string, patch: { name?: string; description?: string; instructions?: string | null; inject?: 'full' | 'summary' }): { ok: boolean; skill?: Skill; error?: string } {
    const idx = this.skills.findIndex((s) => s.id === id);
    const cur = this.skills[idx];
    if (idx < 0 || !cur) return { ok: false, error: 'Skill 不存在' };
    const next: Skill = { ...cur, updatedAt: new Date().toISOString() };
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
    if (typeof patch.description === 'string') next.description = patch.description.trim() || undefined;
    if (patch.instructions !== undefined) {
      const trimmed = patch.instructions?.trim();
      next.instructions = trimmed ? trimmed : undefined;
      next.inject = trimmed ? (patch.inject === 'summary' ? 'summary' : 'full') : undefined;
      /* ⚠️ 用户改过正文 ⇒ **立即清掉出厂指纹**(2026-10-09)。
         语义:builtinFingerprint 存在的唯一含义是「正文仍是出厂那一版」。
         用户一动正文,这个前提就不成立了;若不清,下次启动合并会拿新正文去比旧指纹、
         判成「没动过」→ **把用户的编辑覆盖掉**。
         清空后合并逻辑走「fp 存在但正文不符 ⇒ 尊重用户,不覆盖」分支,编辑永久受保护。 */
      if (next.builtin) next.builtinFingerprint = undefined;
    } else if (patch.inject && next.instructions) {
      next.inject = patch.inject;
      // 只改注入模式、没动正文 —— 指纹保留(正文仍是出厂版),但用户既然显式选了
      // inject,合并时也不该再被出厂值顶掉;故一并清除指纹,视为「用户已介入」。
      if (next.builtin) next.builtinFingerprint = undefined;
    }
    this.skills[idx] = next;
    this.persist();
    return { ok: true, skill: next };
  }

  /** 保存当前项目画布为 Skill(可携带 Agent 操作指令段,「技能双形态」见 docs/Agent技能-指令模板与对话自动加载-产品设计与技术方案.md) */
  save(
    name: string,
    snapshot: { id?: string; projectId: string; nodes: CanvasNode[]; edges: CanvasEdge[] },
    opts?: { instructions?: string; inject?: 'full' | 'summary' },
  ): Skill {
    const now = new Date().toISOString();
    // 参数占位 = 节点数据 + 指令段内的 {占位}(应用/激活时替换)
    const params = new Set<string>();
    for (const p of collectParams(snapshot.nodes)) params.add(p);
    if (opts?.instructions) for (const p of collectParams([{ data: { markdown: opts.instructions } } as CanvasNode])) params.add(p);
    const skill: Skill = {
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      nodes: JSON.parse(JSON.stringify(snapshot.nodes)),
      edges: JSON.parse(JSON.stringify(snapshot.edges)),
      params: [...params],
      description: snapshot.nodes.filter((n) => n.kind === 'document').map((n) => (n.data as { markdown?: string }).markdown ?? '').join('\n').slice(0, 200) || undefined,
      instructions: opts?.instructions?.trim() ? opts.instructions.trim() : undefined,
      inject: opts?.inject ?? (opts?.instructions?.trim() ? 'full' : undefined),
      createdAt: now,
      updatedAt: now,
    };
    this.skills.push(skill);
    this.persist();
    return skill;
  }

  /**
   * 从本地技能文档入库。纯指令技能 nodes/edges 为空;
   * 不标 builtin,所以出现在「我的 Skill」而不是官方精选。
   */
  importDraft(draft: SkillImportDraft): Skill {
    const now = new Date().toISOString();
    const instructions = draft.instructions.trim();
    const nodes = draft.nodes.filter((n): n is CanvasNode => !!n && typeof n === 'object');
    const edges = draft.edges.filter((e): e is CanvasEdge => !!e && typeof e === 'object');
    const params = new Set<string>();
    for (const raw of draft.params) {
      const key = raw.trim().replace(/^\{|\}$/g, '');
      if (key) params.add(`{${key}}`);
    }
    if (instructions) {
      for (const p of collectParams([{ data: { markdown: instructions } } as CanvasNode])) params.add(p);
    }
    for (const p of collectParams(nodes)) params.add(p);
    const skill: Skill = {
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: draft.name.trim(),
      nodes: JSON.parse(JSON.stringify(nodes)) as CanvasNode[],
      edges: JSON.parse(JSON.stringify(edges)) as CanvasEdge[],
      params: [...params],
      description: draft.description?.trim() || undefined,
      instructions: instructions || undefined,
      inject: instructions ? draft.inject : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.skills.push(skill);
    this.persist();
    return skill;
  }

  /**
   * 应用到新项目:克隆节点(新 id)、建项目、写画布。
   * @param paramValues 用户在 Skills 页填的占位值;有则替换,未填的占位清空(可在画布上再改)
   */
  apply(
    skillId: string,
    projectName: string,
    store: ProjectStore,
    paramValues?: Record<string, string>,
  ): Project {
    const skill = this.get(skillId);
    if (!skill) throw new Error('Skill 不存在');
    const values = paramValues ?? {};
    const idMap = new Map<string, string>();
    const nid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nodes = skill.nodes.map((n) => {
      const id = nid(n.kind);
      idMap.set(n.id, id);
      return {
        ...JSON.parse(JSON.stringify(n)),
        id,
        data: applyParamValuesDeep(n.data, values, { keepUnfilled: false }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    const edges = skill.edges.map((e) => ({
      ...e,
      id: nid('edge'),
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
    }));
    const project = store.createProject(projectName);
    // 必须先 createCanvas 再 save —— store 不再对未知 id 静默 push(防删除后 flush 复活)
    const canvas = store.createCanvas(project.id, '主画布');
    store.saveCanvasSnapshot({
      ...canvas,
      nodes,
      edges,
    });
    return project;
  }
}