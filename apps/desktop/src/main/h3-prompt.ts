/**
 * 镜头提示词写作 — 主 Agent 不能自己编 shot 的 prompt。
 *
 * 为什么单独走一次无工具的写作调用(2026-10-13):
 * 内置技能 `h3-prompt-writing` 是 summary 注入,模型经常不 `skills.read`,
 * 写出来的视频提示词不跟 H3 的模式结构。自动激活技能又会顶掉画布上正在用的场景技能。
 * 所以写词收成工具 `h3.write_prompt`:模式由连线判定,规范由服务端载入,
 * 另一次只出正文的模型调用负责落笔。`canvas.update_node` / `create_node` 直接写 shot prompt 会被拒绝。
 * 分镜表铺节点仍走 `assembleH3Prompt` 模板,不经过这里。
 */
import h3PromptWriting from './builtin-skills/h3-prompt-writing.md?raw';

/** 出厂规范全文(技能库里的副本被删或为空时用这份) */
export const H3_PROMPT_WRITING_SPEC = h3PromptWriting;

export const H3_PROMPT_MODES = ['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'Ref2VA'] as const;
export type H3PromptMode = (typeof H3_PROMPT_MODES)[number];

export const H3_MODE_HINT: Record<H3PromptMode, string> = {
  T2VA: '纯文生视频,没有参考素材',
  I2VA: '只有首帧图,从首帧向前发展',
  FL2VA: '首帧加尾帧,写两者之间的连续变化',
  L2VA: '只有尾帧图,推断前序并收敛到尾帧',
  Ref2VA: '有参考图/参考视频/参考音频,按全参考格式写,标签编号必须与清单一致',
};

/** 短于这个长度的模型输出不当作提示词写回(空话、拒答、只回了一个词) */
export const MIN_H3_PROMPT_CHARS = 40;

export const SHOT_PROMPT_VIA_UPDATE =
  '镜头提示词不能用 canvas.update_node 直接写(顶层 prompt 和 data.prompt 都会被拒绝,本次其它字段也不会写入)。' +
  '请改调 h3.write_prompt({ nodeId, brief }):它按连线判定 T2VA/I2VA/FL2VA/L2VA/Ref2VA,载入 H3 提示词规范写成 prompt 再写回。' +
  '改时长/宽高/steps 时不要带 prompt。';

export const SHOT_PROMPT_VIA_CREATE =
  '创建镜头时不要写 prompt(本次节点未创建)。请 canvas.create_node 只带 seconds 和宽高,再用 h3.write_prompt({ nodeId, brief }) 写提示词。';

export interface InboundPort {
  label?: string;
  sourceTitle?: string;
}

/**
 * 由入边端口判定 H3 输入模式。看的是连线意图,不要求上游产物已经落盘
 * (图还在渲染时,边已经说明这一镜是首帧还是全参考)。
 * 有 ref-image / ref-video / ref-audio 时一律 Ref2VA,优先于首尾帧。
 */
export function classifyH3PromptMode(inbounds: Array<{ label?: string }>): H3PromptMode {
  const labels = new Set(inbounds.map((e) => e.label ?? '').filter(Boolean));
  if (labels.has('ref-image') || labels.has('ref-video') || labels.has('ref-audio')) return 'Ref2VA';
  const first = labels.has('first-frame');
  const last = labels.has('last-frame');
  if (first && last) return 'FL2VA';
  if (first) return 'I2VA';
  if (last) return 'L2VA';
  return 'T2VA';
}

/** 按连线顺序给参考标签编号,供写作调用对齐 `<Picture n>` / `<Video n>` / `<Audio n>` */
export function describeInboundRefs(inbounds: InboundPort[]): string {
  let pic = 0;
  let vid = 0;
  let aud = 0;
  const lines: string[] = [];
  for (const e of inbounds) {
    const label = e.label ?? '';
    const title = e.sourceTitle?.trim() || '未命名';
    if (label === 'ref-image') {
      pic += 1;
      lines.push(`- ref-image「${title}」→ <Picture ${pic}>`);
    } else if (label === 'ref-video') {
      vid += 1;
      lines.push(`- ref-video「${title}」→ <Video ${vid}>`);
    } else if (label === 'ref-audio') {
      aud += 1;
      lines.push(`- ref-audio「${title}」→ <Audio ${aud}>`);
    } else if (label === 'first-frame') {
      lines.push(`- first-frame「${title}」→ 首帧图(起点,不是 <Picture>)`);
    } else if (label === 'last-frame') {
      lines.push(`- last-frame「${title}」→ 尾帧图(终点,不是 <Picture>)`);
    }
  }
  return lines.join('\n');
}

/**
 * update_node 是否在改 shot 的 prompt。
 * 调用方应先把顶层 prompt 并进 patch。非 shot、或这次没碰 prompt 键 → 放行。
 */
export function rejectDirectShotPrompt(
  kind: string,
  patch: Record<string, unknown> | undefined,
): string | null {
  if (kind !== 'shot') return null;
  if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'prompt')) return null;
  return SHOT_PROMPT_VIA_UPDATE;
}

/** create_node 的 data 里是否带了非空 prompt(空字符串不算,避免挡掉「只建节点」) */
export function shotCreateCarriesPrompt(data: Record<string, unknown> | undefined): boolean {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'prompt')) return false;
  const p = data.prompt;
  if (p == null) return false;
  return String(p).trim().length > 0;
}

export interface H3PromptMessages {
  system: string;
  user: string;
}

export function buildH3WriteMessages(input: {
  spec: string;
  mode: H3PromptMode;
  title: string;
  seconds: number;
  brief: string;
  /** 用户另给了 brief、节点上又已有提示词时,作为重写底稿,不原样照抄 */
  previous?: string;
  refsText: string;
  skillName?: string;
  skillInstructions?: string;
}): H3PromptMessages {
  const skillBlock =
    input.skillName && input.skillInstructions?.trim()
      ? `\n\n## 当前画布激活技能「${input.skillName}」的约束\n` +
        '写提示词时遵守其中与画面风格、参考标签、语言、角色锁定、时长有关的规则。' +
        '忽略铺节点、提交生成、导出、提问等流程步骤。\n\n' +
        input.skillInstructions.trim()
      : '';
  const system =
    '你是 H3 视频提示词写手。你没有工具,不能建节点,也不能提交生成。\n' +
    '只输出最终 prompt 正文:不要前言、不要解释、不要 markdown 代码围栏、不要写出工具调用。\n' +
    '规范里提到的 canvas.update_node / engine.submit 由外层 Agent 执行。\n\n' +
    input.spec.trim() +
    skillBlock;
  const previous = input.previous?.trim()
    ? `\n\n节点上已有提示词(按规范重写,不要原样照抄):\n${input.previous.trim()}`
    : '';
  const user = [
    `镜头标题: ${input.title}`,
    `输入模式: ${input.mode}(${H3_MODE_HINT[input.mode]})`,
    `请求时长: ${input.seconds} 秒(总时长必须与此一致)`,
    `画面简述:\n${input.brief.trim()}`,
    `已绑定参考(按画布连线顺序;标签编号必须与清单一致,清单里没有的标签不要发明):\n${input.refsText.trim() || '(无参考素材)'}`,
  ].join('\n\n') + previous;
  return { system, user };
}

/** 剥掉思考块和代码围栏;过短则拒绝,调用方不得写回节点 */
export function extractPromptText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  let s = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1]) s = fence[1].trim();
  if (s.length < MIN_H3_PROMPT_CHARS) {
    return {
      ok: false,
      error: `模型没有写出可用的提示词(${s.length} 字,至少 ${MIN_H3_PROMPT_CHARS} 字),没有写回节点。`,
    };
  }
  return { ok: true, text: s };
}

export interface H3ChatEndpoint {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export type H3PromptCompletion =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string };

export type CompleteH3Prompt = (projectId: string, messages: H3PromptMessages) => Promise<H3PromptCompletion>;

function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
    .trim();
}

/**
 * 端点拒绝自定义 temperature 的错误特征
 * (Kimi k3,2026-10 实测:400「invalid temperature: only 1 is allowed for this model」)。
 * 主对话 pi-chat 已有同口径重试;h3.write_prompt 是独立 fetch,必须自己处理。
 */
export const TEMPERATURE_INVALID_RE = /invalid temperature|temperature.*only .*allowed/i;

/**
 * 一次无工具的 chat/completions。截断(finish_reason=length)与空内容都是失败,
 * 调用方不得把半截提示词写进节点。
 *
 * 默认带 temperature=0.2(写作偏稳);若端点只允许默认值,去掉该字段重试一次。
 */
export async function requestH3PromptCompletion(
  endpoint: H3ChatEndpoint,
  messages: H3PromptMessages,
  fetchImpl: typeof fetch = fetch,
): Promise<H3PromptCompletion> {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
  const msgPayload = [
    { role: 'system', content: messages.system },
    { role: 'user', content: messages.user },
  ];

  const post = async (includeTemperature: boolean): Promise<Response> =>
    fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        messages: msgPayload,
        ...(includeTemperature ? { temperature: 0.2 } : {}),
        max_tokens: 8000,
      }),
      signal: AbortSignal.timeout(180_000),
    });

  let res: Response;
  try {
    res = await post(true);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // Kimi 等:自定义 temperature 被拒 → 不下发该字段重试(走端点默认)
      if (res.status === 400 && TEMPERATURE_INVALID_RE.test(errText)) {
        res = await post(false);
      } else {
        return { ok: false, error: `写提示词的模型返回 ${res.status}:${errText.slice(0, 300)}` };
      }
    }
  } catch (e) {
    return { ok: false, error: `写提示词的模型请求失败:${(e as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `写提示词的模型返回 ${res.status}:${text.slice(0, 300)}` };
  }
  let json: { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> };
  try {
    json = (await res.json()) as typeof json;
  } catch (e) {
    return { ok: false, error: `写提示词的模型返回了无法解析的内容:${(e as Error).message}` };
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason === 'length') {
    return {
      ok: false,
      error: '写提示词时输出被截断(stop=length),没有写回节点。请缩短简述后重试 h3.write_prompt。',
    };
  }
  const text = messageText(choice?.message?.content);
  if (!text) return { ok: false, error: '写提示词的模型返回空内容,没有写回节点。' };
  return { ok: true, text, model: endpoint.model };
}
