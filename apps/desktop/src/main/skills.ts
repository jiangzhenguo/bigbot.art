/**
 * SkillStore — Skills 库(PRD §5.5 P0 基础)
 * - 保存:把项目画布(节点结构 + 参数 + 提示词模板)深拷贝为 Skill
 * - 应用:Skill 克隆到新项目画布(换新 id 实体化),返回新项目
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Skill, CanvasNode, CanvasEdge, Project } from '@bigbotart/shared';
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
 * 官方精选出厂技能(纯指令技能;instructions 与 docs/Agent技能文档-撰写指南与模板.md §5 示例同源)。
 * 仅在 skills.json 首次创建时 seed(builtin:true);用户删除后不再自动复活。
 */
const BUILTIN_SKILLS: Array<{ id: string; name: string; description: string; instructions: string; inject?: 'full' | 'summary' }> = [
  {
    id: 'paper-collage',
    name: '纸拼贴剧情片',
    description: '纸拼贴风格竖屏剧情短片;双角色锁定 + 5 镜头结构 + 拼贴材质措辞',
    instructions: `## 任务流程

1. 读需求:用 canvas.list_nodes 找 document 节点,再 document.read 读全文(chunk=0 起);
   提取 {主题}/{旁白}/{时长},缺项用 ask.user 补齐。
2. 规划分镜:storyboard.plan,brief 给 {主题}+{旁白} 融合后的文案,basePrompt 用下方措辞段;
   默认分步只出表,不直接铺节点。
3. 铺节点:storyboard.materialize(aspect=9:16,tier=preview);「需配图=是」的行自动多建 image-gen 首帧。
   保持 5 镜头结构,不新增不合并。
4. 提交生成:逐节点 engine.submit,每次先 ask.user 确认档位与范围,不批量闭眼跑。
5. 收尾:timeline.export,核对 5 镜产物齐全。

## 措辞段

主体:剪贴画拼贴质感,旧杂志纸张撕边,色纸叠加,保留纸纹与胶水痕迹
场景:疏朗留白,主体居中偏左,边缘不规则纸缘
构图:平光无强烈阴影,纸张哑光
风格:纸拼贴剧情片,镜头节奏 2-3 秒一镜
约束:{角色} 身份措辞锁定,不得出现金属/玻璃等非纸材质拟真

## 一致性锁定

- {角色} 每镜同衣饰同配色,跨镜不换装

## 红线

- 重跑任一镜前 ask.user 确认;节点 id 一律 canvas.list_nodes 现拉`,
  },
  {
    id: 'ecom-product',
    name: '电商产品',
    description: '产品三视角批量管线(白背景棚拍风);浅灰背景 + 居中构图 + 逐视角生成',
    instructions: `## 任务流程

1. ask.user 确认 {产品}(资产库选择或文本描述)与 {视角}(如:侧视/开盖/场景)。
2. 每个视角建一个 image-gen 节点(canvas.create_node,prompt 用下方措辞段 + 视角),
   全部接入同一 asset 输入;画幅 16:9,引擎 mlxgen。
3. 每个视角逐个 engine.submit,全部成功后再出时间线(timeline.export)。

## 措辞段

主体:{产品},电商白底棚拍,浅灰背景,产品居中
构图:产品占画面 70%,底部留 15% 阴影区
光影:顶侧柔光,阴影柔和,无反光杂点
风格:电商产品摄影,写实,高分辨率
约束:不出现文字/水印;{视角} 视角精确,不旋转产品

## 一致性锁定

- 三视角背景色、光照方向、产品朝向必须一致

## 红线

- 任一视角失败须报告并重试,不静默跳过`,
  },
  {
    id: 'science-pop',
    name: '科普讲解',
    description: '旁白驱动的图文穿插科普短片;每行=画面+旁白,数据图示占位',
    instructions: `## 任务流程

1. document.read 读需求;按 {旁白} 拆 5-8 段,每段一张画面(1:1)。
2. storyboard.plan 生成分镜表(行=画面+旁白),数据图示列留占位。
3. 铺节点后逐镜 engine.submit,有图示的镜在 image-gen prompt 标注「含数据图表」。
4. timeline.export 合成,图表镜检查旁白时长对齐。

## 措辞段

主体:{主题} 相关图示画面,矢量图表+实拍混排
构图:图表居中,标注文字大而清晰
风格:科普讲解,明亮色调,扁平图示
约束:数据准确,不加夸大文案

## 红线

- 数据数值不得虚构;旁白与画面必须一一对应`,
  },
  /* ---- MiniMax 官方技能(适配版;源:github.com/MiniMax-AI/MiniMax-H3 skills/) ----
   * 大文件一律 inject:'summary'(注入摘要 + skills.read 按需取全文),控制 systemPrompt 体积 */
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
    inject: 'summary',
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
    inject: 'summary',
  },
  {
    id: 'handdrawn-live-video',
    name: '手绘实拍融合视频生成器',
    description: 'MiniMax 官方:基于场景创意,生成手绘动画与实拍接触变形的 15 秒创意短片',
    instructions: handdrawnLiveVideo,
    inject: 'summary',
  },
  {
    id: 'music-video-subtitle',
    name: '音乐MV动态字幕生成器',
    description: 'MiniMax 官方:基于音乐和歌词,完成节奏拆解、镜头设计与动态字幕方案,适用于 AI MV 创作',
    instructions: musicVideoSubtitle,
    inject: 'summary',
  },
  {
    id: 'co-op-game-intro',
    name: '双人游戏开场视频生成器',
    description: 'MiniMax 官方:根据玩家信息、角色参考图和视觉风格,完成首图确认与界面动效设计',
    instructions: coOpGameIntro,
    inject: 'summary',
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

export class SkillStore {
  private skills: Skill[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    const tombstones = readTombstones();
    const seeds = builtinSeed().filter((b) => !tombstones.has(b.id));
    const existing = this.read();
    if (existing.length === 0) {
      // 首次创建 或 空库(从未保存过)时 seed 官方精选(builtin)
      writeFileSync(SKILLS_FILE, JSON.stringify(seeds, null, 2));
      this.skills = seeds;
    } else {
      // 已有技能库:合并官方新增的内置技能(按 id 去重;用户删除过的在 tombstone 里,不复活)
      const have = new Set(existing.map((s) => s.id));
      const missing = seeds.filter((b) => !have.has(b.id));
      this.skills = missing.length ? [...existing, ...missing] : existing;
      if (missing.length) this.persist();
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
    } else if (patch.inject && next.instructions) {
      next.inject = patch.inject;
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

  /** 应用到新项目:克隆节点(新 id)、建项目、写画布 */
  apply(skillId: string, projectName: string, store: ProjectStore): Project {
    const skill = this.get(skillId);
    if (!skill) throw new Error('Skill 不存在');
    // 替换参数占位为空(用户可在画布上改)
    const repl = (v: unknown): unknown => {
      if (typeof v === 'string') return v.replace(/\{[^{}]{1,20}\}/g, '');
      if (Array.isArray(v)) return v.map(repl);
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(o)) out[k] = repl(o[k]);
        return out;
      }
      return v;
    };
    const idMap = new Map<string, string>();
    const nid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nodes = skill.nodes.map((n) => {
      const id = nid(n.kind);
      idMap.set(n.id, id);
      return {
        ...JSON.parse(JSON.stringify(n)),
        id,
        data: repl(n.data),
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
    const now = new Date().toISOString();
    store.saveCanvasSnapshot({
      id: project.activeCanvasId || 'main',
      projectId: project.id,
      name: '主画布',
      nodes,
      edges,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return project;
  }
}