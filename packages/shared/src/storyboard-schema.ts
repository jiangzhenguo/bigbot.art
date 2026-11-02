/**
 * 分镜表结构门(调研改造第 3 步)。
 *
 * 纯函数、零副作用:Agent 规划、主进程铺节点与渲染层铺节点共用同一份判定。
 * 旧 10 列表以及扩展字段全空的确定性兜底表不按电影感完整表拦截;
 * 一旦任一镜开始填写构图字段,就按完整摄影表逐镜核对,避免半套参数悄悄进入提示词。
 */
import { rowCell, rowSeconds } from './prompt.js';
import { rowSegmentKey } from './storyboard-materialize.js';

export type StoryboardSchemaGate = 'composition' | 'cut-change' | 'duration' | 'segment';

export interface StoryboardSchemaIssue {
  gate: StoryboardSchemaGate;
  severity: 'error' | 'warning';
  /** 分镜表数据行号(1-based;镜号列可能不是连续整数,所以不用它定位) */
  row?: number;
  message: string;
}

export interface StoryboardSchemaInput {
  head: string[];
  rows: string[][];
  /** 当前一行仍对应一次生成;缺省沿用 H3 单镜 15 秒上限 */
  maxShotSeconds?: number;
  /** 一段(一次生成)的总时长上限;缺省 15 秒(H3 单次生成上限) */
  maxSegmentSeconds?: number;
  /** 用户明确声明的成片目标秒数;给了才核对全表合计,不猜测 */
  targetSeconds?: number;
  /** 目标总时长容差,缺省 0.15(±15%) */
  targetTolerance?: number;
}

/**
 * 六类构图信息;第二步把「机位」拆成水平角度与机位高度两列,所以物理列是 7 个。
 */
export const STORYBOARD_COMPOSITION_COLUMNS = [
  '焦段',
  '水平角度',
  '机位高度',
  '构图',
  '视线',
  '焦点',
  '稳定性',
] as const;

const EMPTY_DIALOGUE_RE = /^(?:无|无对白|无旁白|暂无|—|-|N\/?A|none)$/i;
const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g;
const LATIN_WORD_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

/**
 * 台词下限估时:中文/日文/韩文按 4 字/秒,拉丁词按 2.5 词/秒,再加明确停顿。
 * 这是审阅用的确定估算,不冒充真实配音时长;短句不必为了估时强行拉长镜头。
 */
export function estimateStoryboardDialogueSeconds(text: string): number {
  const source = String(text ?? '').trim();
  if (!source || EMPTY_DIALOGUE_RE.test(source)) return 0;
  const cjkCount = (source.match(CJK_RE) ?? []).length;
  const latinCount = (source.replace(CJK_RE, ' ').match(LATIN_WORD_RE) ?? []).length;
  const sentencePauses = (source.match(/[。！？!?；;]/g) ?? []).length * 0.25;
  const clausePauses = (source.match(/[，,、：:]/g) ?? []).length * 0.1;
  const longPauses = (source.match(/…|\.\.\./g) ?? []).length * 0.4;
  const linePauses = Math.max(0, source.split('\n').length - 1) * 0.2;
  return cjkCount / 4 + latinCount / 2.5 + sentencePauses + clausePauses + longPauses + linePauses;
}

function secondsText(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** 工具结果/界面 toast 共用人读文案;error 与 warning 分开,警告不阻断。 */
export function storyboardSchemaGateMessage(
  issues: StoryboardSchemaIssue[],
  severity: 'error' | 'warning' = 'error',
): string {
  const selected = issues.filter((issue) => issue.severity === severity);
  if (!selected.length) return '';
  const title = severity === 'error' ? '分镜表结构校验未通过' : '分镜表审阅警告';
  return `${title}:\n${selected.map((issue) => `- ${issue.message}`).join('\n')}`;
}

export function checkStoryboardSchema(input: StoryboardSchemaInput): StoryboardSchemaIssue[] {
  const { head, rows } = input;
  const issues: StoryboardSchemaIssue[] = [];
  const usesComposition = rows.some((row) =>
    STORYBOARD_COMPOSITION_COLUMNS.some((column) => rowCell(row, head, column).trim()),
  );
  if (usesComposition) {
    rows.forEach((row, index) => {
      const missing = STORYBOARD_COMPOSITION_COLUMNS.filter(
        (column) => !rowCell(row, head, column).trim(),
      );
      if (!missing.length) return;
      issues.push({
        gate: 'composition',
        severity: 'error',
        row: index + 1,
        message: `第 ${index + 1} 镜构图信息不完整,缺少:${missing.join('、')}。请补齐;六类构图字段中「机位」拆为水平角度与机位高度两列。`,
      });
    });
  }

  const normalized = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  const relationOf = (row: string[]) =>
    normalized(`${rowCell(row, head, '角色')}|${rowCell(row, head, '站位(blocking)')}`)
      .replace(/^\||\|$/g, '');
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    // 接尾帧是连续动作,不是一次新的剪切;只有真正切镜才要求可见变化。
    if (rowCell(current, head, '衔接').trim() === '接尾帧') continue;
    const previousSize = normalized(rowCell(previous, head, '景别'));
    const currentSize = normalized(rowCell(current, head, '景别'));
    const previousAngle = normalized(rowCell(previous, head, '水平角度'));
    const currentAngle = normalized(rowCell(current, head, '水平角度'));
    const previousRelation = relationOf(previous);
    const currentRelation = relationOf(current);
    // 空值是「未知」,不能当成「相同」;否则旧表会收到大量无依据警告。
    if (!previousSize || !currentSize || !previousAngle || !currentAngle || !previousRelation || !currentRelation) continue;
    if (previousSize !== currentSize || previousAngle !== currentAngle || previousRelation !== currentRelation) continue;
    issues.push({
      gate: 'cut-change',
      severity: 'warning',
      row: index + 1,
      message: `第 ${index + 1} 镜与前一镜的景别、水平角度、人物关系完全相同,这个硬切没有可见变化。建议合并为一镜,或至少改变其中一项。`,
    });
  }

  rows.forEach((row, index) => {
    const seconds = rowSeconds(row, head);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      issues.push({
        gate: 'duration',
        severity: 'error',
        row: index + 1,
        message: `第 ${index + 1} 镜「时长(s)」必须是正数(当前值无法作为镜长)。请填具体秒数,例如 3 或 4.5。`,
      });
      return;
    }
    const maxShotSeconds = input.maxShotSeconds ?? 15;
    if (seconds > maxShotSeconds) {
      issues.push({
        gate: 'duration',
        severity: 'error',
        row: index + 1,
        message: `第 ${index + 1} 镜时长 ${secondsText(seconds)} 秒,超过单次生成上限 ${secondsText(maxShotSeconds)} 秒。请拆镜,或把「时长(s)」改为不超过 ${secondsText(maxShotSeconds)}。`,
      });
    }
    const dialogueSeconds = estimateStoryboardDialogueSeconds(rowCell(row, head, '对白/旁白'));
    if (dialogueSeconds <= 0 || dialogueSeconds <= seconds + 0.05) return;
    issues.push({
      gate: 'duration',
      severity: 'error',
      row: index + 1,
      message:
        `第 ${index + 1} 镜台词估算约 ${secondsText(dialogueSeconds)} 秒,超过镜长 ${secondsText(seconds)} 秒。` +
        `建议把「时长(s)」改为至少 ${secondsText(Math.ceil(dialogueSeconds * 10) / 10)},或拆镜/缩短台词。`,
    });
  });

  const targetSeconds = input.targetSeconds;
  if (targetSeconds !== undefined && Number.isFinite(targetSeconds) && targetSeconds > 0 && rows.length) {
    const totalSeconds = rows.reduce((sum, row) => sum + rowSeconds(row, head), 0);
    const tolerance = input.targetTolerance ?? 0.15;
    const min = targetSeconds * (1 - tolerance);
    const max = targetSeconds * (1 + tolerance);
    if (totalSeconds < min - 0.05 || totalSeconds > max + 0.05) {
      issues.push({
        gate: 'duration',
        severity: 'error',
        message:
          `全表合计 ${secondsText(totalSeconds)} 秒,与目标总时长 ${secondsText(targetSeconds)} 秒不匹配;` +
          `允许范围为 ${secondsText(min)}–${secondsText(max)} 秒(±${Math.round(tolerance * 100)}%)。请调整镜头数量或各镜「时长(s)」。`,
      });
    }
  }

  issues.push(...checkSegments(input));
  return issues;
}

/**
 * 「段」门(调研改造第 4 步)。
 *
 * 段 = 一次生成调用,所以有三条硬约束,全都来自「一次生成」这个事实本身:
 *  1. **同段必须连续**:段是表格里的一段连续行,跳行填同一个段号说明表写错了
 *     (聚合时会把中间那行悄悄排除掉,生成结果与表不一致);
 *  2. **Σ秒 ≤ 单次生成上限**:h3 一次最多 15 秒,超了整段提交必然被拒或截断;
 *  3. **段内第 2 切起不能写「接尾帧」**:段内是同一个视频里的切镜,不存在「接上一镜尾帧」
 *     这回事 —— 那要跨段才成立(跨段接续 = 该段首切写接尾帧)。只警告不阻断,
 *     因为表意仍可读(用户想表达的是「顺着上一镜往下」),强行拦下会打断已有工作流。
 */
function checkSegments(input: StoryboardSchemaInput): StoryboardSchemaIssue[] {
  const { head, rows } = input;
  const issues: StoryboardSchemaIssue[] = [];
  const byKey = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = rowSegmentKey(row, head);
    if (!key) return;
    const list = byKey.get(key);
    if (list) list.push(index + 1);
    else byKey.set(key, [index + 1]);
  });
  if (!byKey.size) return issues;

  const maxSegmentSeconds = input.maxSegmentSeconds ?? 15;
  for (const [key, rowNos] of byKey) {
    const first = rowNos[0]!;
    const last = rowNos[rowNos.length - 1]!;
    if (last - first + 1 !== rowNos.length) {
      issues.push({
        gate: 'segment',
        severity: 'error',
        row: first,
        message:
          `段「${key}」的行不连续(出现在第 ${rowNos.join('、')} 行)。` +
          `同一个段必须是表格里连续的一段行(一次生成 = 一条视频里的多个切);请把同段的镜排到一起,或拆成不同的段号。`,
      });
    }
    const totalSeconds = rowNos.reduce((sum, rowNo) => sum + rowSeconds(rows[rowNo - 1], head), 0);
    if (totalSeconds > maxSegmentSeconds + 0.05) {
      issues.push({
        gate: 'segment',
        severity: 'error',
        row: first,
        message:
          `段「${key}」合计 ${secondsText(totalSeconds)} 秒,超过单次生成上限 ${secondsText(maxSegmentSeconds)} 秒。` +
          `一段 = 一次生成,请把该段拆成两段(例如 ${key} / ${key}-2),或减少段内切数/切长。`,
      });
    }
    rowNos.slice(1).forEach((rowNo, i) => {
      const row = rows[rowNo - 1];
      if (rowCell(row, head, '衔接').trim() !== '接尾帧') return;
      issues.push({
        gate: 'segment',
        severity: 'warning',
        row: rowNo,
        message:
          `第 ${rowNo} 镜在段「${key}」内(是同一段里的第 ${i + 2} 个切),「衔接=接尾帧」在这里不生效:` +
          `段内是同一个视频里的切镜,按硬切处理。跨段接续请写在下一段的首切上。`,
      });
    });
  }
  return issues;
}
