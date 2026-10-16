/**
 * Skill 参数占位 `{name}` 的展示名与替换。
 * 卡片/表单用可读标签;apply/激活时把用户填值写回模板。
 */

/** 常见占位 → 中文标签(未收录的去掉花括号、下划线改空格) */
const PARAM_LABELS: Record<string, string> = {
  主题: '主题',
  旁白: '旁白',
  时长: '时长',
  角色: '角色',
  产品: '产品',
  视角: '视角',
  visual_style: '视觉风格',
  ui_body_color: 'UI 主色',
  text_color: '文字颜色',
  character_count: '角色数量',
  player1_name: '玩家1名称',
  player2_name: '玩家2名称',
  game_title: '游戏标题',
  ui_ref: 'UI 参考',
  player1_ref: '玩家1参考',
  player2_ref: '玩家2参考',
  height_ref: '身高参考',
};

/** 去掉花括号,得到裸名 */
export function paramTokenKey(raw: string): string {
  return raw.replace(/^\{|\}$/g, '').trim();
}

/** 面向用户的可读标签(卡片预览 / 右侧表单) */
export function paramDisplayLabel(raw: string): string {
  const key = paramTokenKey(raw);
  if (!key) return raw;
  if (PARAM_LABELS[key]) return PARAM_LABELS[key]!;
  // 中文裸名直接用;英文 snake_case → 空格分隔
  if (/[\u4e00-\u9fff]/.test(key)) return key;
  return key.replace(/_/g, ' ');
}

/**
 * 替换字符串里的 `{占位}`。
 * - 有填值 → 替换为填值
 * - 未填:`keepUnfilled=true` 保留原文(激活指令,留给 Agent ask.user);
 *         `false` 清空(铺节点到画布,与历史行为一致)
 */
export function applyParamValues(
  text: string,
  values: Record<string, string>,
  opts?: { keepUnfilled?: boolean },
): string {
  const keep = opts?.keepUnfilled === true;
  return text.replace(/\{([^{}]{1,20})\}/g, (full, name: string) => {
    const v = values[full] ?? values[name];
    if (v != null && String(v).trim() !== '') return String(v);
    return keep ? full : '';
  });
}

/** 递归替换对象/数组里的字符串占位(铺节点时改 node.data) */
export function applyParamValuesDeep(
  v: unknown,
  values: Record<string, string>,
  opts?: { keepUnfilled?: boolean },
): unknown {
  if (typeof v === 'string') return applyParamValues(v, values, opts);
  if (Array.isArray(v)) return v.map((x) => applyParamValuesDeep(x, values, opts));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = applyParamValuesDeep(o[k], values, opts);
    return out;
  }
  return v;
}
