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
 *
 * ⚠️ 2026-09:`shot → image-edit` 的 inputFrameSource 派发已移除 —— 视频不再直连图片编辑,
 *    改用 frame-grab(视频裁切取帧)节点落成图片。存量画布上的 inputFrameSource 仍由 runNode 兼容读取。
 *
 * 拆分的价值:计算与 React 解耦 —— 输入 (nodes, edges),输出 { nextNodes, changed },
 * 可直接单测;CanvasPage 通过 nodesReducer 的 derive-from-edges action 消费它。
 */
import type { PromptSource } from '@bigbotart/shared';
import { inferPromptSource } from '@bigbotart/shared';
import type { CanvasNode, Edge } from './types';
import { pickShotSpec, IMAGE_KINDS, VIDEO_KINDS } from './connectors';
import { SHOT_REF_ROLES } from './constants';

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
  const imageFromPatch = new Map<string, { nodeId: string } | null>();
  /** 🆕 参考图端口 ref-image(多值):image-edit 多参考编辑(Qwen-Image-2.1 `qwen21.edit` 支持 1-10 张) */
  const editRefPatch = new Map<string, string[]>();
  /** 视频输入端口(video-upscale / frame-grab 的输入):只收视频来源(shot/video-upscale/视频 asset) */
  const videoFromPatch = new Map<string, { nodeId: string } | null>();
  /** 🆕 audio-ref 节点的来源视频(视频 → 音频参考节点;抽取由渲染层副作用完成) */
  const audioFromPatch = new Map<string, { nodeId: string } | null>();
  /** 拼接件入边(image-stitch):label=piece / piece-N;带源节点坐标,写回时按目标 mode 排序 */
  const stitchPatch = new Map<string, Array<{ nodeId: string; x: number; y: number }>>();
  const promptFromPatch = new Map<string, { nodeId: string } | null>();
  /** 镜头画面规格继承(shot → shot):目标节点 → 要写入的规格键值 */
  const specPatch = new Map<string, Record<string, unknown>>();
  const specFromPatch = new Map<string, { nodeId: string } | null>();
  /** 接续/直通自动切换 mode(默认文生 → 首帧);ref-image 边另见 refImageEdgeNodes */
  const modePatch = new Map<string, string>();
  /** 有「首帧端口」入边的 shot 节点(用于删边后把自动切换的 mode 收回) */
  const frameEdgeNodes = new Set<string>();
  /**
   * 有「参考图端口」入边的 shot(2026-10-12「测试技能2」事故):
   * 连了 ref-image 却停在 text2video → UI 显示「文生」、检查器参考槽按文生过滤,
   * 用户以为参考图没生效。有 ref-image 且无 first-frame 时自动切 mode=ref-image。
   * ⚠️ first-frame 优先(与 h3 `--ref-image`/`--first-frame` 互斥一致)。
   */
  const refImageEdgeNodes = new Set<string>();

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
        // ref-image 边不误切首帧 —— h3 的 --ref-image 与 --first-frame 互斥(连接器设计 §10.4)
        const isFirstFrameEdge = e.label === 'first-frame';
        const hasFrameEdge = (fromShot || fromImage || src.kind === 'asset') && isFirstFrameEdge;
        // 只要存在「首帧端口」入边就登记(与是否需要切换 mode 无关),供删边后收回判断
        if (hasFrameEdge) {
          frameEdgeNodes.add(e.to);
          // 下游没显式选过模式(仍是默认文生/自动关联)时,自动切「首帧」
          if ((modeRaw === 'text2video' || modeRaw === 'ref-image') && !modeOverridden) {
            modePatch.set(e.to, 'first-frame');
          }
        }
        // 登记参考图入边(图片产物 / 资产);写 mode 在下方 apply 阶段统一裁决
        if (e.label === 'ref-image' && (fromImage || src.kind === 'asset')) {
          refImageEdgeNodes.add(e.to);
        }
        const effMode = modePatch.get(e.to) ?? modeRaw;
        const frameOk = effMode === 'first-frame' || effMode === 'first-last';
        /* 自动注入的让位规则(仅单值角色):
           - 用户已手动绑定同名角色 ⇒ 手动的优先,不再自动注入
           - 用户在该角色上点过 ×(refsSuppressed)⇒ 尊重停用 */
        const curRefs = Array.isArray(d.refs) ? (d.refs as Array<{ role?: string; auto?: boolean }>) : [];
        const suppressedRoles = Array.isArray(d.refsSuppressed) ? (d.refsSuppressed as string[]) : [];
        const SINGLE_ROLES = ['first-frame', 'last-frame', 'ref-audio', 'ref-video'];
        /* 用户手选了模式(modeOverride)时,该模式需要的角色不再被 refsSuppressed 挡住。
           2026-10-13:旧 × 只写停用、不删边。切到「首帧」后清晨阳台仍不出现,
           因为 first-frame 还在停用名单里,和当前模式无关。 */
        const activeMode = modeOverridden ? modeRaw : effMode;
        const modeRoles = new Set((SHOT_REF_ROLES[activeMode] ?? []).map((rd) => rd.role));
        const autoBlocked = (role: string) =>
          SINGLE_ROLES.includes(role) &&
          (curRefs.some((r) => !r.auto && r.role === role) ||
            (suppressedRoles.includes(role) && !(modeOverridden && modeRoles.has(role))));
        if (src.kind === 'asset') {
          // 资产引用注入:按边 label 决定角色 —— 图片资源可作「首帧参考(first-frame)」或「参考图(ref-image)」,
          // 视频资源可作「参考视频(ref-video)」,音频资源作「音轨参考(ref-audio)」
          const role =
            e.label === 'first-frame' ? 'first-frame'
            : e.label === 'ref-image' ? 'ref-image'
            : e.label === 'ref-audio' ? 'ref-audio'
            : e.label === 'ref-video' ? 'ref-video'
            : undefined;
          const assetId = String(s.assetId ?? '');
          if (role && assetId && !autoBlocked(role)) arr.push({ assetId, role, auto: true });
        } else if (fromShot) {
          // 镜头接续:上游尾帧 → 下游首帧
          if (frameOk && !autoBlocked('first-frame')) {
            const tail = String(s.tailFramePath ?? '');
            if (tail) arr.push({ path: tail, role: 'first-frame', auto: true });
          }
          // 参考视频(h3 --ref-video):上游**整段成片**作 Ref2VA 参考(风格/动作),
          // 与「尾帧作首帧」是两个独立语义;产物未就绪时不注入(提交期 W004 兜底)
          if (e.label === 'ref-video' && !autoBlocked('ref-video')) {
            const mp4 = String(s.resultPath ?? '');
            if (mp4) arr.push({ path: mp4, role: 'ref-video', auto: true });
          }
          // 音频参考(ref-audio,2026-10-08):上游成片的**内嵌音轨**作声音参考。
          // 这里登记的是**视频文件路径**,抽音轨在提交期做(runNode → extractAudio)
          // —— 派发是纯函数,不能有 ffmpeg 副作用。
          if (e.label === 'ref-audio' && !autoBlocked('ref-audio')) {
            const mp4 = String(s.resultPath ?? '');
            if (mp4) arr.push({ path: mp4, role: 'ref-audio', auto: true });
          }
          // 画面规格继承:比例 + 档位(三件套)整组取自上游;下游手动改过则不再覆盖
          if (d.specOverride !== true) {
            const spec = pickShotSpec(s);
            if (Object.keys(spec).length) specPatch.set(e.to, spec);
          }
          specFromPatch.set(e.to, { nodeId: e.from });
        } else if (VIDEO_KINDS.includes(src.kind ?? '')) {
          // 视频产物 → 镜头(如 video-upscale 增强成片):ref-video 参考视频;
          // first-frame 端口不在此注入 —— 端口载荷是静帧,须先经 frames 取帧
          if (e.label === 'ref-video' && !autoBlocked('ref-video')) {
            const mp4 = String(s.resultPath ?? '');
            if (mp4) arr.push({ path: mp4, role: 'ref-video', auto: true });
          }
          // 音频参考:登记视频路径,提交期抽音轨(同 shot → shot 的 ref-audio)
          if (e.label === 'ref-audio' && !autoBlocked('ref-audio')) {
            const mp4 = String(s.resultPath ?? '');
            if (mp4) arr.push({ path: mp4, role: 'ref-audio', auto: true });
          }
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
        // VIDEO_KINDS(video-upscale / timeline 成片)同样可整段入轨
        //(video-upscale → timeline 此前连接器表宣称支持、这里漏了派发,2026-10 一并补上)
        const isClip =
          src.kind === 'shot' ||
          src.kind === 'director' ||
          src.kind === 'audio-ref' ||
          IMAGE_KINDS.includes(src.kind ?? '') ||
          VIDEO_KINDS.includes(src.kind ?? '');
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
          'frame-grab': 'image',
          'video-upscale': 'video',
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
        // 输入图端口 input(单值):静帧产物直通 / 素材引用
        // 🆕 参考图端口 ref-image(多值):与 input 分开累积(2026-09-29 接线 2.1 多参考编辑,
        //    此前该 case 不区分 label,任何入边都覆盖 inputImageFrom → 多图参考画得出边却只留最后一张)
        // ⚠️ 不再有 `shot` 分支:视频 → 图片编辑的直连已取消(图片编辑要静帧,
        //    视频须先经 frame-grab 落成图片)。frame-grab 产物已计入 IMAGE_KINDS,走下面这支。
        // ⚠️ 派生态 inputImageFrom **不是**检查器显示的充分条件:`data.inputAssetId` 一旦有值,
        //    解析侧(CanvasPage.runNode 与 ImageEditInspector.resolveEditInputImage)会**优先**用它,
        //    填了个查不到的 ID 就等于把连线信息挤掉(2026-10 事故:来源卡在、图是空的)。
        if (IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
          if (e.label === 'ref-image') {
            const arr = editRefPatch.get(e.to) ?? [];
            if (!arr.includes(e.from)) arr.push(e.from);
            editRefPatch.set(e.to, arr);
          } else {
            imageFromPatch.set(e.to, { nodeId: e.from });
          }
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
      case 'video-upscale': {
        // 输入**视频**端口 input:镜头成片 / 视频增强产物 / 视频素材;无条件登记(幂等)
        if (src.kind === 'shot' || VIDEO_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
          videoFromPatch.set(e.to, { nodeId: e.from });
        }
        break;
      }
      case 'frame-grab': {
        // 输入**视频**端口 input-video:镜头成片 / 视频增强产物 / 视频素材(只收视频源)。
        // 这是「视频 → 图片」的唯一合法转换点:产物 PNG 再交给 image-edit/upscale/… 下游。
        if (src.kind === 'shot' || VIDEO_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
          videoFromPatch.set(e.to, { nodeId: e.from });
        }
        break;
      }
      case 'audio-ref': {
        /* 🆕 视频 → 音频参考节点(2026-10-08):登记来源视频,抽取在连接时执行
           (见 CanvasPage 的 audioRefSync effect —— 抽音轨有 ffmpeg 副作用,派发保持纯函数)。
           只收**带音轨的视频产物**(shot / video-upscale);音频 asset 不走这条路
           (audio-ref 的 assetId 由检查器或抽取结果直接绑定)。 */
        if (src.kind === 'shot' || VIDEO_KINDS.includes(src.kind ?? '')) {
          audioFromPatch.set(e.to, { nodeId: e.from });
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
      // 手选模式需要的角色,清掉旧 × 留下的停用标记,避免「模式已切、图仍被藏」
      if (data.modeOverride === true && Array.isArray(data.refsSuppressed)) {
        const keepRoles = new Set((SHOT_REF_ROLES[String(data.mode ?? 'text2video')] ?? []).map((rd) => rd.role));
        const nextSuppressed = (data.refsSuppressed as string[]).filter((role) => !keepRoles.has(role));
        if (nextSuppressed.length !== (data.refsSuppressed as string[]).length) {
          data.refsSuppressed = nextSuppressed;
        }
      }
      // 画面规格来源标记(检查器显示「继承自上游镜头 X」)
      const sf = specFromPatch.get(n.id) ?? null;
      if (sf) data.specFrom = sf;
      else delete data.specFrom;
      // 比例 + 档位继承(用户手动改过 ⇒ specOverride=true,不再覆盖)
      const spec = specPatch.get(n.id);
      if (spec && data.specOverride !== true) Object.assign(data, spec);
      // 模式:入边驱动自动切换;手动选过模式(modeOverride)则不动。
      // 优先级:first-frame 入边 > ref-image 入边 > 收回文生。
      if (data.modeOverride !== true) {
        if (frameEdgeNodes.has(n.id)) {
          const wantMode = modePatch.get(n.id);
          if (wantMode) data.mode = wantMode;
          else if (data.mode === 'text2video' || data.mode === 'ref-image') data.mode = 'first-frame';
        } else if (refImageEdgeNodes.has(n.id)) {
          if (data.mode === 'text2video' || data.mode === 'first-frame') data.mode = 'ref-image';
        } else if (data.mode === 'first-frame' || data.mode === 'ref-image') {
          data.mode = 'text2video';
        }
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
    // 输入图端口 input(静帧直通 / 素材):与边同步,删除边即撤销
    if (n.kind === 'image-edit' || n.kind === 'image-upscale' || n.kind === 'image-crop' || n.kind === 'image-split') {
      const target = imageFromPatch.get(n.id) ?? null;
      if (target) data.inputImageFrom = target;
      else delete data.inputImageFrom;
    }
    // 🆕 参考图端口 ref-image(多值,仅 image-edit):与边同步,删除边即撤销
    if (n.kind === 'image-edit') {
      const refs = editRefPatch.get(n.id) ?? [];
      if (refs.length) data.refImageFrom = refs.map((id) => ({ nodeId: id }));
      else delete data.refImageFrom;
    }
    // 视频输入端口(video-upscale / frame-grab):与边同步,删除边即撤销
    if (n.kind === 'video-upscale' || n.kind === 'frame-grab') {
      const target = videoFromPatch.get(n.id) ?? null;
      if (target) data.inputVideoFrom = target;
      else delete data.inputVideoFrom;
    }
    /* audio-ref 的来源视频:记录来源节点 id,供渲染层据此抽音轨。
       删边即撤销 —— 同时要把**抽出来的产物绑定**一并清掉(否则会留下一个
       与任何连线都无关的 assetId,用户看不出它从哪来)。 */
    if (n.kind === 'audio-ref') {
      const target = audioFromPatch.get(n.id) ?? null;
      if (target) data.inputAudioFrom = target;
      else {
        delete data.inputAudioFrom;
        delete data.sourceVideoPath;
      }
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