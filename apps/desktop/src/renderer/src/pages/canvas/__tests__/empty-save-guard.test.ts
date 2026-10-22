/**
 * 空快照保存闸(渲染层)— 2026-10-20「测试主画布删不掉节点」回归
 *
 * 事故:`maybePersist` 写着「本地 0 节点 && store 有节点 → 直接 return」,且**没读** allowEmpty。
 * 于是删掉画布上最后一个节点时保存被静默丢弃,写盘广播把旧节点推回来 → 用户看到「删不掉」。
 *
 * 修法:三条件同时成立才拦 —— 本地空 + store 有 + **不是**(已装填该画布 且 调用方声明 allowEmpty)。
 * 本文件锁这四种组合,尤其是「未装填时不得放行」(2026-09-22 整张画布被抹空的事故形态)。
 */
import { describe, it, expect } from 'vitest';
import { shouldBlockEmptySave } from '../empty-save-guard';

const base = {
  localEmpty: true,
  localEdges: 0,
  storeHasNodes: true,
  allowEmpty: true,
  hydrated: true,
  userCleared: true,
};

describe('shouldBlockEmptySave', () => {
  it('用户删空(已装填 + allowEmpty + userCleared)→ 放行', () => {
    expect(shouldBlockEmptySave(base)).toBe(false);
  });

  it('⚠️ 0 节点 + 有边(悬空边)→ 永远拦,哪怕 allowEmpty/hydrated/userCleared 全给', () => {
    // 2026-10-20 事故形态:渲染层窗口期 nodes 空、edges 还在,上一版凭 allowEmpty 放行,
    // 两个项目被抹成 0 节点 + 11/16 悬空边
    expect(shouldBlockEmptySave({ ...base, localEdges: 11 })).toBe(true);
    expect(shouldBlockEmptySave({ ...base, localEdges: 1, userCleared: false })).toBe(true);
  });

  it('没有用户删空凭证(只是 allowEmpty + hydrated)→ 拦(窗口期空 refs 不得落盘)', () => {
    expect(shouldBlockEmptySave({ ...base, userCleared: false })).toBe(true);
  });

  it('未装填(切画布/崩溃重挂的瞬间)+ allowEmpty → 仍拦(2026-09-22 事故形态)', () => {
    expect(shouldBlockEmptySave({ ...base, hydrated: false })).toBe(true);
  });

  it('已装填但调用方没声明 allowEmpty(卸载/切画布 flush)→ 拦', () => {
    expect(shouldBlockEmptySave({ ...base, allowEmpty: false })).toBe(true);
  });

  it('store 里这张画布本来就是空的 → 不需要拦(无事可保护)', () => {
    expect(shouldBlockEmptySave({ ...base, storeHasNodes: false })).toBe(false);
  });

  it('本地有节点 → 永远不拦(正常保存)', () => {
    expect(shouldBlockEmptySave({ ...base, localEmpty: false })).toBe(false);
  });
});
