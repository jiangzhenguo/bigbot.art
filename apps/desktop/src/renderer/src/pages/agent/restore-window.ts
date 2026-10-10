/**
 * 历史恢复窗口(纯函数,2026-10-09 「对话消失了」事故修复)
 *
 * 事故形态:用户重启 App 后打开「测试1」画布,发现整段对话不见了。
 * 数据其实**完好**(memory.json 里 45 条 recall 一条不少),是渲染层恢复时
 * 只取 `slice(-20)` 把它挡在了窗口外:
 *
 *   - 最后 20 条 = 10 条 tool + 10 条 system,**一条 user/assistant 都没有**;
 *   - 被挤掉的 25 条里装着全部 12 条真实对话
 *     (「2个美女在飞机机翼上打斗」「写实电影感」「激烈打斗」「铺节点并生成」…)。
 *
 * 为什么这次特别严重:Agent 在「铺节点并生成」后一口气发了 **8 个 engine.submit**,
 * 每个产生 tool + system **两条**记录 —— **单轮吃掉 16+ 条**,把整段对话冲了出去。
 * 平时轮次短不会触发,「一轮大量并行提交」是压垮它的典型形态。
 *
 * ⚠️ 主进程 memory.ts 的 recall **注入**窗口早就修过同一问题
 * (`RECALL_INJECT_LIMIT` 只数可注入角色,tool 记录不占窗口,注释里写着
 * 「编辑图片让女孩站立」的真实事故),**但渲染层的恢复没跟上这个口径**。
 * 本模块就是让渲染层与主进程对齐。
 */
import type { RecallMessage } from '@bigbotart/shared';

/**
 * 恢复窗口:最多回显多少条**人类可读**记录(user / assistant / ask 卡片)。
 * 机器记录(role='tool' / 'system')**不占这个额度**,但仍会带上紧邻的那些
 * (否则工具卡片组会断在半截,看不出「这轮干了什么」)。
 */
export const RESTORE_HUMAN_LIMIT = 20;

/** 该记录是否算「人类可读」(占恢复额度) */
function isHumanReadable(r: RecallMessage): boolean {
  return r.role === 'user' || r.role === 'assistant' || (r.role === 'tool' && r.toolName === 'ask.user');
}

/**
 * 选出要恢复的 recall 记录(保持原顺序)。
 *
 * 规则只有一条,但正是旧代码缺的那条:**额度只数人类可读记录**。
 *   ① 从后往前数满 `humanLimit` 条人类可读记录,其位置即窗口起点;
 *      中间夹多少 tool/system 都不影响 —— 人类对话再也不会被工具记录挤掉;
 *   ② 起点之后(含起点)的记录**全部带上**,让每张工具卡都有上下文,
 *      不会出现「有工具卡但没有对应的用户指令」的断裂。
 *
 * 旧实现是 `slice(-20)`(所有角色一起数),单轮 8 个 engine.submit
 * 就能吃掉 16+ 条额度,把整段对话冲出去 —— 这就是本模块要修的东西。
 *
 * @param recall  该画布的全部 recall(调用方已按 canvasId 过滤)
 * @param humanLimit 回显的人类消息条数上限(默认 20,与旧行为的数量级一致)
 */
export function selectRestoreWindow(
  recall: RecallMessage[],
  humanLimit: number = RESTORE_HUMAN_LIMIT,
): RecallMessage[] {
  if (recall.length === 0) return [];

  // 从后往前数出第 humanLimit 条人类可读记录的位置
  let humanSeen = 0;
  let start = 0;
  for (let i = recall.length - 1; i >= 0; i--) {
    const r = recall[i];
    if (!r) continue;
    if (isHumanReadable(r)) {
      humanSeen += 1;
      if (humanSeen >= humanLimit) {
        start = i;
        break;
      }
    }
  }

  return recall.slice(start);
}
