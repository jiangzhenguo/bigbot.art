/**
 * Agent 对话面板的类型(ChatMsg / ToolRun / ModelOption)。
 * 注意:消息类型只存数据,不存 ReactNode——渲染由 cards/ 下的展示组件负责。
 */
import type { LlmSource, AskOption } from '@bigbotart/shared';

/** 工具执行行(ToolRunCard 聚合卡的一行) */
export interface ToolRun {
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
  nodeId?: string;
}

/** 执行计划卡数据(agentPlan / 首页规划落地) */
export interface PlanData {
  document?: unknown;
  shots?: unknown[];
  report?: string;
  brief?: string;
}

/** 连续性校验卡数据(引擎任务完成后自动触发) */
export interface CheckData {
  issues: string[];
  result?: string;
}

export interface ChatMsg {
  id: number;
  kind: 'user' | 'agent' | 'sys';
  /** 纯文本消息 */
  text?: string;
  /** 用户消息携带的附件(展示用) */
  attachments?: Array<{ name: string; kind: string }>;
  /** 模型思考内容(ThinkingBlock 折叠展示;不进记忆) */
  thinking?: string;
  /** 设计稿里的 data-od-id 标识 */
  odId?: string;
  /** 执行计划卡(PlanCard) */
  plan?: PlanData;
  /** 连续性校验卡(ContinuityCard) */
  check?: CheckData;
  /** 工具调用卡数据(旧格式,逐条平铺;保留仅为兼容历史快照渲染) */
  toolCall?: { name: string; args: Record<string, unknown>; status: 'running' | 'success' | 'error'; result?: string; nodeId?: string };
  /** 本轮工具执行聚合(ToolRunCard;设计文档 §3.3) */
  toolRuns?: ToolRun[];
  /** 🆕 技能注入卡(配置事件:激活/停用/读取;与工具执行卡并列但独立,见设计稿 trc-skill) */
  skill?: {
    action: 'activate' | 'deactivate' | 'read';
    skillId: string;
    name: string;
    inject?: 'full' | 'summary';
    /** 注入全文(激活 full 时展示,可展开) */
    instructionsText?: string;
    /** 激活预览(前 N 字符,工具返回) */
    preview?: string;
  };
  /** 确认卡片(Agent 调 ask.user 暂停,等待用户点选);options 已归一化为 AskOption;picked 记录用户点选(写回消息数据,重进页面/恢复历史后仍可回显) */
  ask?: { question: string; options: AskOption[]; picked?: string };
  /** 错误卡(ErrorCard;retryText 存在时显示「重试本轮」) */
  error?: { title: string; detail: string; retryText?: string };
  /** loading 占位(发送后到回复前) */
  loading?: boolean;
}

export interface ModelOption {
  name: string;
  sub: string;
  source?: LlmSource;
  reset?: boolean;
}
