/**
 * edge-dispatch — 统一边分派:边 → 下游节点 data 自动填充(纯函数 + reducer)
 *
 * 自 CanvasPage 的「统一边分派」effect 拆出(P0 · docs/视频节点下游连接规划.md §3):
 *   边 → 下游节点 data 自动填充,删除边时同步移除对应自动项(手动项保留):
 *   - asset → shot:refs[role=ref-audio/ref-image](沿用需求 7,auto 标记)
 *   - shot → shot:refs[role=first-frame] 指向上游尾帧 PNG(待上游 tailFramePath 就绪后注入)
 *   - shot / asset(video|audio) → timeline:shotNodeIds 入线(按边序去重)
 *   - 操作节点 → workflow-output:outputs[].sourceNodeIds(按 kind 匹配)
 *   - asset / document → workflow-input(label=slot-<name>):slots[name].value
 *   - shot → image-edit:inputFrameSource(取帧再编辑的帧源)
 *
 * 拆分的价值:计算与 React 解耦 —— 输入 (nodes, edges),输出 { nextNodes, changed },
 * 可直接单测;CanvasPage 通过 nodesReducer 的 derive-from-edges action 消费它。
 */
import type { PromptSource } from '@bigbotart/shared';
import { inferPromptSource } from '@bigbotart/shared';
import type { CanvasNode, Edge } from './types';
import { pickShotSpec, IMAGE_KINDS } from './connectors';

type RefEntry = { assetId?: string; path?: string; role: string; auto?: boolean };

export interface EdgeDerivationResult {
  nextNodes: CanvasNode[];
  /** JSON 内容比对:只有内容真的变了才置 true(引用不同但内容相同不触发 setState) */
  changed: boolean;
}

/**
 * 由 (nodes, edges) 计算边派生态写回后的节点列表。
 * 纯函数:不读 ref、不 setState;写回语义与原 CanvasPage effect 完全一致。
 */
export function computeEdgeDerivations(nodes: CanvasNode[], edges: Edge[]): EdgeDerivationResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refPatch = new Map<string, RefEntry[]>();
  const timelinePatch = new Map<string, string[]>();
  const outputPatch = new Map<string, Record<string, string[]>>();
  const slotPatch = new Map<string, Array<{ name: string; value: unknown }>>();
  const framePatch = new Map<string, { videoNodeId: string; at: 'first' | 'last' } | null>();
  const imageFromPatch = new Map<string, { nodeId: string } | null>();
  /** 拼接件入边(image-stitch):label=piece / piece-N;带源节点坐标,写回时按目标 mode 排序 */
  const stitchPatch = new Map<string, Array<{ nodeId: string; x: number; y: number }>>();
  const promptFromPatch = new Map<string, { nodeId: string } | null>();
  /** 镜头画面规格继承(shot → shot):目标节点 → 要写入的规格键值 */
  const specPatch = new Map<string, Record<string, unknown>>();
  const specFromPatch = new Map<string, { nodeId: string } | null>();
  /** 接续/直通自动切换 mode(默认文生 → 首帧) */
  const modePatch = new Map<string, string>();
  /** 有「首帧端口」入边的 shot 节点(用于删边后把自动切换的 mode 收回) */
  const frameEdgeNodes = new Set<string>();

  for (const e of edges) {
    const src = byId.get(e.from);
    const dst = byId.get(e.to);
    if (!src || !dst) continue;
    const d = (dst.data ?? {}) as Record<string, unknown>;
    const s = (src.data ?? {}) as Record<string, unknown>;
    switch (dst.kind) {
      case 'shot': {
        const arr = refPatch.get(e.to) ?? [];
        const modeRaw = String(d.mode ?? 'text2video');
        const modeOverridden = d.modeOverride === true;
        const fromShot = src.kind === 'shot';
        const fromImage = IMAGE_KINDS.includes(src.kind ?? '');
        // 只有「首帧端口」入边才自动切 mode(默认文生 → 首帧);
        // ref-image(参考图)边不误切首帧 —— h3 的 --ref-image 与 --first-frame 互斥(连接器设计 §10.4)
        const isFirstFrameEdge = e.label === 'first-frame';
        const hasFrameEdge = (fromShot || fromImage || src.kind === 'asset') && isFirstFrameEdge;
        // 只要存在「首帧端口」入边就登记(与是否需要切换 mode 无关),供删边后收回判断
        if (hasFrameEdge) {
          frameEdgeNodes.add(e.to);
          // 下游没显式选过模式(仍是默认文生)时,自动切「首帧」
          if (modeRaw === 'text2video' && !modeOverridden) modePatch.set(e.to, 'first-frame');
        }
        const effMode = modePatch.get(e.to) ?? modeRaw;
        const frameOk = effMode === 'first-frame' || effMode === 'first-last';
        /* 自动注入的让位规则(仅单值角色):
           - 用户已手动绑定同名角色 ⇒ 手动的优先,不再自动注入
           - 用户在该角色上点过 ×(refsSuppressed)⇒ 尊重停用 */
        const curRefs = Array.isArray(d.refs) ? (d.refs as Array<{ role?: string; auto?: boolean }>) : [];
        const suppressedRoles = Array.isArray(d.refsSuppressed) ? (d.refsSuppressed as string[]) : [];
        const SINGLE_ROLES = ['first-frame', 'last-frame', 'ref-audio', 'ref-video'];
        const autoBlocked = (role: string) =>
          SINGLE_ROLES.includes(role) &&
          (suppressedRoles.includes(role) || curRefs.some((r) => !r.auto && r.role === role));
        if (src.kind === 'asset') {
          // 资产引用注入:按边 label 决定角色 —— 图片资源可作「首帧参考(first-frame)」或「参考图(ref-image)」
          const role =
            e.label === 'first-frame' ? 'first-frame'
            : e.label === 'ref-image' ? 'ref-image'
            : e.label === 'ref-audio' ? 'ref-audio'
            : undefined;
          const assetId = String(s.assetId ?? '');
          if (role && assetId && !autoBlocked(role)) arr.push({ assetId, role, auto: true });
        } else if (fromShot) {
          // 镜头接续:上游尾帧 → 下游首帧
          if (frameOk && !autoBlocked('first-frame')) {
            const tail = String(s.tailFramePath ?? '');
            if (tail) arr.push({ path: tail, role: 'first-frame', auto: true });
          }
          // 画面规格继承:比例 + 档位(三件套)整组取自上游;下游手动改过则不再覆盖
          if (d.specOverride !== true) {
            const spec = pickShotSpec(s);
            if (Object.keys(spec).length) specPatch.set(e.to, spec);
          }
          specFromPatch.set(e.to, { nodeId: e.from });
        } else if (fromImage) {
          // 图片产物 → 镜头(图生视频双端口):
          // - first-frame:静帧直通首帧(全链路自动切首帧模式)
          // - ref-image:结果图作 Ref2VA 参考(多值端口,可多条,与资产图 ref-image 行为一致)
          if (e.label === 'first-frame') {
            if (frameOk && !autoBlocked('first-frame')) {
              const img = String(s.resultPath ?? '');
              if (img) arr.push({ path: img, role: 'first-frame', auto: true });
            }
          } else if (e.label === 'ref-image') {
            const img = String(s.resultPath ?? '');
            if (img) arr.push({ path: img, role: 'ref-image', auto: true });
          }
        }
        if (arr.length) refPatch.set(e.to, arr);
        // 提示词端口 prompt:document → 下游 prompt(仅自身 prompt 为空时生效,运行期解析)
        if (src.kind === 'document' && String(s.markdown ?? '').trim()) {
          const cur = d.promptFrom as PromptSource | undefined;
          const next: PromptSource = { nodeId: e.from, ...inferPromptSource(String(s.markdown ?? '')) };
          if (!cur || cur.nodeId !== e.from || cur.mode !== next.mode || (cur.blockId ?? '') !== (next.blockId ?? '')) {
            promptFromPatch.set(e.to, next);
          }
        }
        break;
      }
      case 'timeline': {
        // 入线端口 clip / audio-track:视频、静帧、编排、音轨、音视频素材
        const asMedia = src.kind === 'asset' && ['video', 'audio'].includes(String(s.mediaType ?? ''));
        const isClip = src.kind === 'shot' || src.kind === 'director' || src.kind === 'audio-ref' || IMAGE_KINDS.includes(src.kind ?? '');
        if (isClip || asMedia) {
          const arr = timelinePatch.get(e.to) ?? [];
          if (!arr.includes(e.from)) arr.push(e.from);
          timelinePatch.set(e.to, arr);
        }
        break;
      }
      case 'workflow-output': {
        const kindOf: Record<string, string> = {
          shot: 'video',
          director: 'video',
          'image-gen': 'image',
          'image-edit': 'image',
          'image-upscale': 'image',
          'image-crop': 'image',
          'image-stitch': 'image',
          'image-split': 'image',
          'audio-ref': 'audio',
          asset: String(s.mediaType ?? ''),
        };
        const kind = kindOf[src.kind ?? ''];
        if (!kind || kind === 'document') break;
        const outputs = Array.isArray(d.outputs) ? (d.outputs as Array<{ name: string; kind: string }>) : [];
        const mp = outputPatch.get(e.to) ?? {};
        for (const o of outputs) {
          if (o.kind !== kind) continue;
          const arr = mp[o.name] ?? [];
          if (!arr.includes(e.from)) arr.push(e.from);
          mp[o.name] = arr;
        }
        outputPatch.set(e.to, mp);
        break;
      }
      case 'workflow-input': {
        if (!e.label?.startsWith('slot-')) break;
        const name = e.label.slice(5);
        const slots = Array.isArray(d.slots) ? (d.slots as Array<{ name: string; accept: string[] }>) : [];
        // 精确槽位名优先;占位 label(slot-<名称>,目标节点创建时尚不知槽位名)按来源类型匹配 accept
        const srcAccept =
          src.kind === 'document'
            ? 'text'
            : src.kind === 'asset'
              ? (String(s.mediaType ?? 'image') === 'image' ? 'image' : String(s.mediaType ?? 'image') === 'video' ? 'video' : String(s.mediaType ?? 'image') === 'audio' ? 'audio' : 'document')
              : undefined;
        const placeholder = name === '<名称>' || name === '默认';
        const slot = slots.find((x) => x.name === name)
          ?? (placeholder && srcAccept ? slots.find((x) => x.accept.includes(srcAccept)) : undefined)
          ?? (['image', 'video', 'audio', 'text', 'document'].includes(name) ? slots.find((x) => x.accept.includes(name)) : undefined);
        if (!slot) break;
        let value: unknown;
        if (src.kind === 'asset') {
          const assetId = String(s.assetId ?? '');
          if (!assetId) break;
          value = { kind: 'asset', assetId };
        } else if (src.kind === 'document') {
          const md = String(s.markdown ?? '');
          if (!md) break;
          value = { kind: 'inline-text', text: md };
        } else break;
        const arr = slotPatch.get(e.to) ?? [];
        arr.push({ name: slot.name, value });
        slotPatch.set(e.to, arr);
        break;
      }
      case 'image-edit': {
        if (src.kind === 'shot') {
          const cur = d.inputFrameSource as { videoNodeId?: string; at?: string } | undefined;
          const next = { videoNodeId: e.from, at: 'first' as const };
          if (!cur || cur.videoNodeId !== next.videoNodeId || cur.at !== next.at) framePatch.set(e.to, next);
        } else if (IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
          // 输入图端口 input:静帧产物直通 / 素材引用;无条件登记(内容比对由 JSON 兜底,保证幂等)
          imageFromPatch.set(e.to, { nodeId: e.from });
        }
        if (src.kind === 'document' && String(s.markdown ?? '').trim()) {
          const cur = d.promptFrom as PromptSource | undefined;
          const next: PromptSource = { nodeId: e.from, ...inferPromptSource(String(s.markdown ?? '')) };
          if (!cur || cur.nodeId !== e.from || cur.mode !== next.mode || (cur.blockId ?? '') !== (next.blockId ?? '')) {
            promptFromPatch.set(e.to, next);
          }
        }
        break;
      }
      case 'image-gen':
      case 'director': {
        // 提示词端口 prompt:document → 下游 prompt
        if (src.kind === 'document' && String(s.markdown ?? '').trim()) {
          const cur = d.promptFrom as PromptSource | undefined;
          const next: PromptSource = { nodeId: e.from, ...inferPromptSource(String(s.markdown ?? '')) };
          if (!cur || cur.nodeId !== e.from || cur.mode !== next.mode || (cur.blockId ?? '') !== (next.blockId ?? '')) {
            promptFromPatch.set(e.to, next);
          }
        }
        break;
      }
      case 'image-upscale': {
        // 输入图端口 input(超分源):静帧产物直通 / 素材引用;无条件登记(幂等)
        if (IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
          imageFromPatch.set(e.to, { nodeId: e.from });
        }
        break;
      }
      case 'image-crop': {
        // 输入图端口 input(裁切源):静帧产物直通 / 素材引用;无条件登记(幂等)
        if (IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
          imageFromPatch.set(e.to, { nodeId: e.from });
        }
        break;
      }
      case 'image-split': {
        // 输入图端口 input(拆分源):静帧产物直通 / 素材引用;无条件登记(幂等)
        if (IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
          imageFromPatch.set(e.to, { nodeId: e.from });
        }
        break;
      }
      case 'image-stitch': {
        // 拼接件端口 piece(多值):静帧产物 / 素材;记录源坐标供排序(横排按 x,竖排/网格按 y)
        if ((IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') && (e.label ?? '').startsWith('piece')) {
          const arr = stitchPatch.get(e.to) ?? [];
          arr.push({ nodeId: e.from, x: src.x, y: src.y });
          stitchPatch.set(e.to, arr);
        }
        break;
      }
    }
  }

  /* 写回:先把所有派生态**无条件**写进克隆的 data,最后用 JSON 内容比对决定是否 setState。
     这样做的目的:任何"引用不同但内容相同"的误判(曾导致 Maximum update depth 无限重渲染)
     都不会触发 setState —— 只有内容真的变了才写入。 */
  let dirty = false;
  const nextNodes = nodes.map((n) => {
    const data = { ...(n.data ?? {}) };
    const refKey = (r: RefEntry) => (r.assetId ? `${r.assetId}:${r.role}` : `path:${r.path}:${r.role}`);

    if (n.kind === 'shot') {
      const incoming = refPatch.get(n.id) ?? [];
      const cur = Array.isArray(data.refs) ? ((data.refs as unknown[]) as RefEntry[]) : [];
      const manual = cur.filter((r) => !r.auto);
      const merged = [...manual];
      for (const r of incoming) {
        const idx = merged.findIndex((m) => refKey(m) === refKey(r));
        if (idx >= 0) merged[idx] = r;
        else merged.push(r);
      }
      data.refs = merged;
      // 画面规格来源标记(检查器显示「继承自上游镜头 X」)
      const sf = specFromPatch.get(n.id) ?? null;
      if (sf) data.specFrom = sf;
      else delete data.specFrom;
      // 比例 + 档位继承(用户手动改过 ⇒ specOverride=true,不再覆盖)
      const spec = specPatch.get(n.id);
      if (spec && data.specOverride !== true) Object.assign(data, spec);
      // 模式:接续/直通时自动切「首帧」;手动选过模式(modeOverride)则不动
      if (data.modeOverride !== true) {
        const wantMode = modePatch.get(n.id);
        if (wantMode) data.mode = wantMode;
        else if (!frameEdgeNodes.has(n.id) && data.mode === 'first-frame') data.mode = 'text2video';
      }
    }
    if (n.kind === 'timeline') {
      // manualOrder=true(用户手动排序/删除过):尊重 data 里的 shotNodeIds,不被入边自动重排覆盖;
      // 否则仍由入边派生态全权维护(删边即撤销入线)。
      // 手动模式下仍把新入边追加到末尾,让后续连线依然能入线。
      const manual = (n.data as { manualOrder?: boolean })?.manualOrder === true;
      if (manual) {
        const cur = Array.isArray((n.data as { shotNodeIds?: unknown }).shotNodeIds)
          ? ((n.data as { shotNodeIds: string[] }).shotNodeIds ?? [])
          : [];
        const incoming = timelinePatch.get(n.id) ?? [];
        const merged = [...cur];
        for (const id of incoming) {
          if (!merged.includes(id)) merged.push(id);
        }
        data.shotNodeIds = merged;
      } else {
        data.shotNodeIds = timelinePatch.get(n.id) ?? [];
      }
    }
    if (n.kind === 'workflow-output') {
      const incomingMap = outputPatch.get(n.id);
      const curOut = Array.isArray(data.outputs) ? (data.outputs as Array<{ name: string; kind: string; sourceNodeIds: string[] }>) : [];
      // 边是 sourceNodeIds 的唯一来源:无入边即空(镜像派生态,删除边即撤销)
      data.outputs = curOut.map((o) => ({ ...o, sourceNodeIds: incomingMap?.[o.name] ?? [] }));
    }
    if (n.kind === 'workflow-input') {
      const byName = new Map((slotPatch.get(n.id) ?? []).map((x) => [x.name, x.value]));
      const curSlots = Array.isArray(data.slots) ? (data.slots as Array<{ name: string; accept: string[]; required?: boolean; value?: unknown }>) : [];
      // value 完全由 slot-<name> 边决定:边删除 → 清回未填充
      data.slots = curSlots.map((x2) => ({ ...x2, value: byName.has(x2.name) ? byName.get(x2.name) : undefined }));
    }
    if (n.kind === 'image-edit') {
      const target = framePatch.get(n.id) ?? null;
      if (target) data.inputFrameSource = target;
      else delete data.inputFrameSource;
    }
    // 输入图端口 input(静帧直通 / 素材):与边同步,删除边即撤销
    if (n.kind === 'image-edit' || n.kind === 'image-upscale' || n.kind === 'image-crop' || n.kind === 'image-split') {
      const target = imageFromPatch.get(n.id) ?? null;
      if (target) data.inputImageFrom = target;
      else delete data.inputImageFrom;
    }
    // 拼接件端口 piece(多值):按目标 mode 排序(row 按 x,column/grid 按 y;同级再按另一轴),边删除即撤销
    if (n.kind === 'image-stitch') {
      const ents = stitchPatch.get(n.id) ?? [];
      const mode = String(data.mode ?? 'column');
      const sorted = [...ents].sort((a, b) =>
        mode === 'row' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x,
      );
      if (sorted.length) data.piecesFrom = sorted.map((e2) => ({ nodeId: e2.nodeId }));
      else delete data.piecesFrom;
    }
    // 提示词端口 prompt:与边同步(运行期「自身 prompt 为空才用文档全文」)
    if (['image-gen', 'image-edit', 'shot', 'director'].includes(n.kind ?? '')) {
      const target = promptFromPatch.get(n.id) ?? null;
      if (target) data.promptFrom = target;
      else delete data.promptFrom;
    }
    if (JSON.stringify(data) === JSON.stringify(n.data ?? {})) return n;
    dirty = true;
    return { ...n, data };
  });
  return { nextNodes, changed: dirty };
}

/** nodes 状态机:节点全部写入统一走本 reducer(derive-from-edges 供边分派消费) */
export type NodesAction =
  | { type: 'set'; updater: (nodes: CanvasNode[]) => CanvasNode[] }
  | { type: 'derive-from-edges'; edges: Edge[] };

export function nodesReducer(state: CanvasNode[], action: NodesAction): CanvasNode[] {
  switch (action.type) {
    case 'set':
      return action.updater(state);
    case 'derive-from-edges': {
      const r = computeEdgeDerivations(state, action.edges);
      return r.changed ? r.nextNodes : state;
    }
  }
}