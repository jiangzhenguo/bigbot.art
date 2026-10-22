/**
 * 「空快照能否落盘」判定(纯函数,画布自动保存的前置闸)。
 *
 * 背景(2026-10-20「测试主画布删不掉节点」→ 修完又炸出「进项目节点全丢」):
 * `CanvasPage.maybePersist` 里原本写着
 *   `if (本地 0 节点 && store 有节点) return;`
 * 用来挡 2026-09-22 的「未装填 flush 把整张画布抹空」事故 —— 但它是**无条件**的:
 * 用户删掉画布上最后一个节点时,本地 0 节点、store 里(旧 prop)还有 1 个,
 * 于是这次保存被静默丢弃,节点下一秒被写盘广播推回来,用户视角就是「删不掉」。
 *
 * 第一版修法只放了 `allowEmpty + hydrated`,**范围太宽**:渲染层在某个窗口期会构造出
 * 「nodes 空、edges 还在」的快照(结构损坏),它被 allowEmpty 放行,直接把两个项目的画布抹成
 * 0 节点 + 11/16 悬空边。所以现在分两层:
 *
 *  ① **结构性损坏一律拦**:0 节点 + 有边 = 悬空边,永远不是合法编辑结果(边不可能比节点先存在)。
 *     这一条不看任何开关,allowEmpty 也不例外。
 *  ② 空快照覆盖有内容的画布:只有「**用户真的把最后一个节点删掉**」才放行 ——
 *     判定依据是 `userCleared`(由 deleteNodes 在结果为空时显式置位),
 *     不再只看 allowEmpty/hydrated。未装填的 flush、窗口期的空 refs 都过不去。
 */
export function shouldBlockEmptySave(opts: {
  /** 本次快照 nodes 数为 0 */
  localEmpty: boolean;
  /** 本次快照 edges 数(0 节点 + >0 边 = 结构损坏) */
  localEdges: number;
  /** store 当前这张画布有节点 */
  storeHasNodes: boolean;
  /** 调用方声明这次清空是合法编辑(内容变更触发的自动保存) */
  allowEmpty: boolean;
  /** 本地状态已装填**同一张**画布 */
  hydrated: boolean;
  /** 用户确实通过删除操作把这张画布删空了(deleteNodes 置位,换画布/重载时复位) */
  userCleared: boolean;
}): boolean {
  // ① 结构损坏:边引用的节点不存在,永远不写盘
  if (opts.localEmpty && opts.localEdges > 0) return true;
  // ② 覆盖闸:只有「用户删空 + 已装填 + 明确声明」三条同时成立才放行
  if (!opts.localEmpty || !opts.storeHasNodes) return false;
  return !(opts.allowEmpty && opts.hydrated && opts.userCleared);
}
