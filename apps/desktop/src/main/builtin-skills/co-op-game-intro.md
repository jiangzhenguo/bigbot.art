## 适用场景

当用户想制作一条双人合作游戏的主菜单/开场动画,并希望先锁定人物再确认主菜单静帧、最后生成开场视频时,使用本技能。适用于合作游戏概念展示、角色化菜单和社交内容;不适用于完整可玩游戏开发、复杂多页面 UI、精确品牌标识复刻或无角色的通用片头。

## 核心硬规矩(不可跳步 · 2026-10-12「测试技能2」事故)

> ⚠️ **一致性靠参考图连线,不是提示词。** 事故形态:只出了一张主菜单静帧、没出 PLAYER 角色卡 → 后续镜头 mode 停在「文生」→ 7 镜并行提交 → 人物锁不住、成片接不齐。

1. **先角色卡,再主菜单静帧,最后视频**(顺序不可颠倒):
   - 用户已上传 P1/P2 图 → `assets.import` 入库,再各建一个 image-gen「角色卡·PLAYER1/2」用上传图作 `ref-image` 重绘为所选风格(半身/¾ 正面、简洁背景、**无 UI/无菜单**)。
   - 无上传图 → 仍必须先建两张角色卡 image-gen 并 `engine.submit` 出图,`ask.user` 确认后再进主菜单静帧。
   - **禁止**把「主菜单双人合影静帧」当成唯一人物锁——合影图锁不住分镜里的单独脸部。
2. **默认交付路径 = 2 角色卡 + 1 确认静帧 + 1 个 ~15 秒 shot**(不要拆附录 B 时间轴为 7 个独立镜头并行提交)。一个 shot 用完整英文视频 prompt 覆盖整段时间轴事件。
3. **多镜仅当用户明确要求**;若拆镜必须同时满足:
   - 每镜 `canvas.connect` 角色卡×2(+ 可选确认静帧作 UI 锚)→ `label=ref-image`;
   - `canvas.update_node({ data: { mode: "ref-image", modeOverride: true } })`(**关联模式**,禁止停在 text2video 文生);
   - 提示词写 Ref2VA 结构,用 `<Subject n>` / `<Picture n>` 引用连线顺序;
   - 镜间连续性用上游 shot → 下游 `first-frame`(尾帧接续);**first-frame 与 ref-image 互斥**,接续镜不要两套同时连;
   - **串行提交**:上一镜 `succeeded` 再 `engine.submit` 下一镜,禁止一次丢进队列 7 镜。
4. **镜头 01 主菜单待机可用 first-frame**(确认静帧直通);其余动作/过场镜优先 `ref-image` 锁角色卡。

## 默认创作目标

产出一条包含双人角色、玩家信息卡和主菜单交互动效的游戏开场视频(默认约 15 秒、16:9),路径为:

1. 锁定视觉风格 + 玩家/游戏信息;
2. **两张角色卡**(image-gen,用户确认);
3. 一张经用户确认的 16:9 主菜单静帧(image-gen,角色卡经 `ref-image` 注入);
4. **一个** shot 节点回填完整视频 prompt(角色卡 + 静帧作 `ref-image`,mode=`ref-image`),经 h3.c 出片后 `timeline.export`。

## 任务流程

1. **读需求与素材入库**:`document.read` / `canvas.list_nodes`;上传的 PLAYER 参考图先 `assets.import`。缺玩家名、游戏名、视觉风格时用 `ask.user` 补齐。
2. **出角色卡(强制门)**:建「角色卡·PLAYER1」「角色卡·PLAYER2」两个 image-gen → 提交 → 用户确认。未确认前不得铺视频镜头。
3. **主菜单确认静帧**:建/铺 image-gen 主菜单静帧,把两张角色卡 `canvas.connect`(label=`ref-image`)连上再提交;用户确认前不得进视频。
4. **铺视频节点(默认单镜)**:建 **一个** shot(~15s,16:9,tier 先 preview)。把角色卡×2 + 确认静帧连为 `ref-image`,并 `update_node` 设 `mode=ref-image, modeOverride=true`。若分镜表被 materialize 成多行,删除多余 shot 或只提交主镜头,勿七镜齐发。
5. **回填并提交视频**:按附录 B 把风格/角色锚点/玩家名/游戏名/UI/时间轴事件写成**一条**英文 prompt 写入该 shot,`engine.submit`;用 `engine.queue_status` 跟踪。先 preview,确认后再提档。
6. **导出与核对**:`timeline.export`;核对角色卡、确认静帧、视频 Take、导出文件齐全再交付。

## 视觉风格询问(第一步)

先用 `ask.user` 以弹窗式问题给出预设风格和自定义选项,让用户先选整体画风。用户选择的风格是最高优先级,会影响:整体风格补充、色彩语言、背景纹理、人物画风、表情气质、穿搭风格、UI 颜色、按钮图标和字体质感。

## 玩家与游戏信息收集

收集 PLAYER 1 名字、PLAYER 2 名字、游戏名字。角色参考图经 `assets.import` 入库后,**必须**再落到画布 image-gen「角色卡」节点并出图确认(见核心硬规矩 §1);上传图只用于身份映射:可识别脸型轮廓、发型、眼镜、五官相对比例和个人特征。**不要**继承真人摄影质感、皮肤纹理、现实光影、相机质感或原图风格;人脸必须在保留身份锚点的前提下重绘为用户选择的视觉风格。

## 确认首图 Prompt 框架(14 条规则)

确认首图 prompt 必须采用「框架固定 + 风格动态填充 + 颜色联动」的写法(完整模板见附录 A):

1. **整体风格**:固定保留「游戏主菜单 UI、高品质游戏宣传海报、UI 与角色深度融合、现代商业游戏 UI 设计、极强视觉冲击力、画面简洁干净、避免过度装饰」;其他风格词根据用户选择补充。
2. **色彩设计**:固定使用「xx 色作为主体颜色、xx 色作为 UI 主体颜色、xx 色作为文字颜色、xx 色作为功能强调色、红色作为危险提示色、整体颜色控制在 5 种以内、高对比撞色、鲜明现代、xx 风格色彩语言」的结构;具体颜色根据用户风格推导。后续 UI、按钮、图标、字体段落必须与本段色彩保持一致。
3. **整体布局**:固定保留 16:9 横版构图、背景铺满、中央放置两位角色、UI 围绕角色不遮挡、左上玩家信息卡、右侧纵向菜单、底部警戒胶带、四角少量涂鸦、Z 字阅读路径、留白充足、层级清晰、视觉重心集中 Continue。
4. **背景设计**:固定使用「纯 xx 色背景、轻微 xx 纹理、大面积纯色留白、纹理仅作细节、避免大量脏污/密集划痕/过多泼墨/大面积油漆飞溅、边缘少量黑色喷漆、整体简洁现代高级、突出 UI 主体」的结构;xx 根据用户风格推导。
5. **人物风格**:严格按照用户选择的风格拓展,不可用模板默认风格压过用户选择。
6. **左侧人物 Character A**:五官信息参考角色图 1;表情、画风、穿搭根据用户选择风格分析并改写(可参考「卡其色短夹克、黑色内搭、黑色工装裤、棕色皮靴、探险家风格穿搭」等维度,但必须服务用户风格);动作固定为双腿交叉坐地、双手撑地、身体微微后仰、抬头望向镜头。
7. **右侧人物 Character B**:五官信息参考角色图 2;表情、画风、穿搭根据用户选择风格分析并改写(可参考「绿色厚夹克、酒红色羽绒内胆、白色内衬、黑色长裤、厚底皮靴」等维度);动作固定为双腿盘坐、双手自然放于腿前、身体略微前倾、正视镜头。
8. **灯光表现**:固定保留顶部主光源、左上暖色或冷色补光、底部柔和环境反光、柔软阴影、明显接触阴影、轻微轮廓光、高质量 GI 全局光照、人物自然融入背景。冷暖选择根据用户风格推导。
9. **UI 整体设计**:固定保留 Console Game Menu 风格、按钮统一尺寸、统一圆角矩形、略微倾斜布局、少量喷漆与滴落元素、现代简洁、贴纸化设计、突出可读性、避免过度装饰。按钮主体色、描边色、发光描边色必须匹配第 2 点色彩设计。
10. **UI 排版规则**:所有菜单按钮横向长条、统一宽高与圆角、按钮宽度适配文字、标题单行显示、严禁换行、严禁两行标题、文字水平居中、左右留白一致、垂直间距统一。
11. **按钮设计**:颜色按第 2 点色彩设计,图标可适当修改但必须符合用户风格。Continue 是视觉中心、超大尺寸、最强高亮、鼠标悬停/点击状态;Start New Game 位于 Continue 上方;Settings 保持统一视觉语言;Exit Game 使用危险/退出提示,可保留红色危险点缀。
12. **玩家信息卡**:固定保留左上角两名玩家信息栏、不规则矩形卡片、描边、轻微破损、左侧 Logo/图标、右侧三级信息(PLAYER 名称、玩家昵称、READY 状态)、粗体无衬线字体、工业贴纸设计。卡片颜色、描边色、READY 颜色、Logo 风格根据第 2 点和用户风格生成。
13. **图标设计**:图标风格根据用户选择动态生成,颜色匹配第 2 点;排列规则不变:单排横向、严禁自动换行、严禁上下堆叠、每个 UI 模块最多一排图标、数量精简、统一尺寸、不抢视觉焦点。
14. **字体设计**:超粗无衬线、全部大写、类似 Anton/Impact/Burbank/Tungsten、字距紧凑、笔画粗壮、信息层级明确、单行排版、禁止自动换行、按钮宽度优先适配文字长度、任何情况不得出现两行菜单标题。字体颜色和纹理根据第 2 点与用户风格匹配。

## 首图确认与迭代

先只出一张图给用户确认,不要直接进入视频。首图需要保留框架结构,同时让用户选择的风格在视觉上明确成立。在用户确认首图或提出修改之前,不生成视频;用户改了风格、名字、游戏名、角色形象或首图问题,就回到首图 prompt 阶段重写并重新生成。

## 视频 Prompt 回填与生成

角色卡 + 主菜单静帧均确认后,把结果回填进**一条**完整视频 prompt(附录 B):风格、`<Subject n>` 角色锁、玩家名字、游戏名字、UI 文案、固定时间轴事件和负面约束。连线顺序建议:`角色卡·P1` → `角色卡·P2` → `确认静帧` 均为 `ref-image`(对应 `<Picture 1/2/3>`)。**shot.mode 必须是 `ref-image`(关联)**。**提交给 h3.c 的最终 prompt 用英文撰写;UI 界面文案(按钮文字、玩家名、游戏名)保留原文。** 写入 shot 后 `engine.submit`。

## 常见失败修正

- 文字不清楚 → 减少画面中的文字量;
- 角色串位 → 检查两张角色卡是否都连上 `ref-image`,并在 prompt 里用 `<Subject n>` 点名左右位置;
- 脸型/发型漂移 → 缺角色卡时先补卡再重提;禁止只靠主菜单合影静帧锁脸;
- mode 仍是「文生」→ `update_node` 设 `mode=ref-image, modeOverride=true` 后重提;
- 多镜队列卡死 / 成片接不齐 → 收敛为单镜 15s,或串行提交 + 尾帧接续;
- 画面没体现用户风格 → 重写整体风格、色彩设计、人物风格、背景纹理、UI 颜色、按钮、图标和字体段落,而不是改动布局框架。

---

## 附录 A:H3 确认首图模板(规则全文,去重压缩)

# H3 Confirmation Image Template

## Core Rule
Generate a polished 16:9 landscape confirmation image for a cooperative game main menu. The image consists of two independent systems: UI Framework (fixed) and Visual Style (dynamic). The UI Framework defines layout, composition, information hierarchy, interaction logic, reading flow, menu structure, and readability — these must remain unchanged. {visual_style} only controls artistic appearance: rendering medium, materials, color language, lighting mood, environment style, character design, costume language, UI materials, icon language, typography appearance, decorative motifs, and overall atmosphere. Changing {visual_style} should feel like applying a different art direction to the same professionally designed game menu, never redesigning the interface itself. If any default description conflicts with {visual_style}, prioritize {visual_style} while preserving the UI framework.

## Design Goal
Create a premium commercial console game main menu mockup in 16:9 landscape format, combining polished game promotional artwork quality with professional game UI clarity. Characters and interface must feel naturally integrated, with strong visual hierarchy, excellent readability, clean composition, and a clear interaction focus.

## Overall Style
Follow the user-selected visual style: {visual_style}. It controls rendering medium, illustration style, materials, palette language, environment, character appearance, outfit design, UI appearance, icon language, typography treatment, decorative elements, and atmosphere. All visual elements must belong to one unified artistic language; do not mix incompatible visual styles. The UI framework, layout, hierarchy, composition, and interaction logic must remain consistent regardless of style.

## Color Palette
Derive the entire color system from {visual_style}. Use {main_background_color} as primary background, {ui_body_color} as main UI color, {text_color} as primary text color, {functional_accent_color} as interaction highlight; red only for warning/danger/exit. Limit the palette to five primary colors. All buttons, player cards, icons, borders, highlights, decorative elements, typography, and visual effects must follow the same color system; no unrelated colors.

## Composition
Fixed 16:9 landscape layout. Place {character_count} playable characters in the center as the visual subject; UI surrounds characters without blocking them. Player information cards in the upper-left; main menu vertical on the right; a decorative horizontal strip along the bottom adapted to {visual_style} (ribbon, warning strip, wooden plank, stone slab, energy bar, scroll, etc.). Clear Z-shaped reading flow: Player Cards → Characters → Menu → Continue Button. The Continue button is always the primary visual focus. Generous negative space, excellent readability.

## Background
Derived naturally from {visual_style}; supports the interface rather than competing with it. Keep clean negative space behind all important UI elements; subtle textures/details only where appropriate. Avoid excessive visual noise, dense decoration, heavy dirt, scratches, paint splatter, or distracting textures. Polished, premium, modern, suitable for a commercial game menu.

## Character Style
All characters strictly follow {visual_style}: rendering medium, body proportion, facial stylization, costume language, material treatment, lighting response, animation style, overall quality. Only identity anchors and pose remain fixed; facial rendering, eye design, nose simplification, mouth shape, skin treatment, expression style, and head proportion must be fully reinterpreted in {visual_style}. No default character style may override {visual_style}.

## Character A / PLAYER 1
Identity: use reference image 1 only for identity mapping — it donates identity anchors only (recognizable face silhouette, hairstyle, glasses if present, relative facial proportions, distinctive personal traits), not photographic realism, real skin texture, real-world lighting, camera quality, or the original image style. Keep identity anchors, but redesign the face into {visual_style}; all facial rendering follows {visual_style}. Do not swap identity with other characters.
Appearance: rendering, expression, outfit, materials, accessories fully derived from {visual_style}, keeping a recognizable playable-game-character silhouette.
Action: sits cross-legged on the ground, both hands support the body on the floor, upper body leans slightly backward, looks upward toward the camera.

## Character B / PLAYER 2
Identity: same rules as Character A, using reference image 2.
Appearance: same rules as Character A.
Action: sits cross-legged on the ground, both hands rest naturally in front of the legs, upper body leans slightly forward, looks directly toward the camera.

## Lighting
Follows {visual_style} while preserving readability: primary top light, secondary fill light, soft ambient bounce, contact shadows, gentle rim lighting, high-quality global illumination where appropriate. Faces clearly visible; characters integrate naturally into the environment with strong separation from the background.

## Game UI
Professional commercial console game main menu. Menu structure, interaction hierarchy, spacing, composition, reading flow, and information architecture remain fixed; {visual_style} only changes artistic appearance. The style may affect: UI materials, surface textures, border treatment, corner shape, decorative motifs, color rendering, lighting treatment, icon language, typography appearance, interaction effects. It must NOT change: menu hierarchy, button order, button placement, player-card placement, composition, interaction logic, information architecture, readability. The whole interface feels like one professionally designed game UI system, not assembled separate elements.

## UI Visual Language
Derive complete UI appearance from {visual_style}: button materials, border language, panel materials, decorative details, edge treatment, visual weight, highlight style, interaction feedback, shadow treatment, texture language. Possible materials: wood, stone, paper, leather, cloth, glass, crystal, hologram, neon, metal, ceramic, carved/painted surfaces, magical energy, pixel blocks, watercolor paper, ink brush, comic graphics, or any material naturally belonging to {visual_style}. Every UI element shares the same material language and artistic style.

## Button Layout Rules
All menu buttons vertical on the right side; consistent vertical rhythm; same design family; width adapts to text length; titles on a single line; no automatic wrapping; no stacked text; text horizontally centered; consistent padding; equal spacing; no visual clutter.

## Continue Button
Always the primary visual focus, made dominant with emphasis methods naturally belonging to {visual_style}: larger size, stronger contrast, brighter color, unique material, distinctive border, lighting, glow, engraving, magical energy, holographic effect, embossed frame, animated visual cue. Do not force glow or neon if they conflict with {visual_style}. It must immediately attract the player's attention.

## Start New Game Button
Placed above Continue; standard secondary button appearance consistent with the selected style; one small style-appropriate icon if suitable; single-line text.

## Settings Button
Standard secondary appearance; one settings icon naturally derived from {visual_style}; consistent proportions, spacing, hierarchy.

## Exit Game Button
Standard secondary appearance; red only as the danger indicator, remaining an accent rather than dominant; one style-appropriate exit icon if suitable.

## Player Cards
Upper-left player information system for {character_count} players; appearance follows {visual_style} (card materials, borders, corners, textures, shadows, decorations, icons auto-derived). Each card contains: player label, player nickname, READY status. Names: PLAYER 1 {player1_name} / PLAYER 2 {player2_name}. READY always uses the functional accent color. Cards stay highly readable and visually connected to the interface.

## Icon System
All icons derived from {visual_style}, one unified icon family throughout. Possible languages: minimal outline, solid filled, geometric, comic, pixel, engraved, carved, painted, brush, rune, glyph, holographic, crystal, paper-cut, origami, embossed, low-poly, flat design, stylized 3D. All icons share the same artistic style, material language, perspective, lighting treatment, stroke language, and color hierarchy. Simple, recognizable, functional. Each interface block may contain at most one horizontal row of icons; no wrapping, no vertical stacking; icons support rather than dominate the interface.

## Typography
Hierarchy fixed; appearance follows {visual_style} (font family, decorative treatment, texture, material, outline, lighting, shadow, wear pattern). Maintain: excellent readability, strong hierarchy, single-line menu buttons, consistent spacing, high contrast. Button width always adapts to text length; menu titles never wrap onto multiple lines.

## Game Title
Display the game title: {game_title}. It becomes the menu's primary branding element; material, decorative style, typography, rendering all follow {visual_style}. Do not imitate existing commercial game logos; create an original title treatment. Highly readable; no random symbols or meaningless letters.

## Interaction States
Represent the interface as an active game menu; buttons may show interaction feedback naturally belonging to {visual_style}: hover, pressed state, magical glow, energy pulse, holographic highlight, carved illumination, ink spread, brush bloom, metallic reflection, paper emboss, animated border, pixel flashing. Only effects native to the selected style; never force modern UI effects into incompatible styles.

## Rendering
Polished AAA-quality commercial game menu artwork; characters, environment, UI, typography, icons, decorative elements feel like one cohesive production. Premium quality, strong visual hierarchy, professional presentation, high readability, balanced composition, clean finish.

## Negative Constraints
No split screen. No duplicated characters. No identity swap. No loss of identity anchors. No photorealistic face unless {visual_style} explicitly requires photorealism. No realistic photo face pasted onto a stylized body. No mismatched face style. No hairstyle changes. No unreadable UI. No distorted buttons. No overlapping interface. No random text. No random symbols. No watermark. No copied game logo. No branded interface. No inconsistent icon styles. No mixed UI materials. No excessive decoration. No overwhelming background. No visual clutter. No broken layout. No low readability.

## Medium Lock
Render as polished commercial game key art combined with a professional console game main menu mockup. The interface remains fixed; only the artistic appearance changes with {visual_style}.

---

## 附录 B:H3 视频 Prompt 模板(规则全文,去重压缩)

# H3 Video Prompt Template

## Prompt principle
Same method as the confirmation-image prompt: **fixed video event framework + dynamic user-style fill + locked character identity + palette-linked UI system.** The video prompt must not blindly preserve the source prompt's default style; it preserves the timeline, UI events, player positions, equipment logic, and text structure, while dynamically rewriting visual treatment, palette, character rendering, lighting, UI surface, icons, and city-world style per the user's selected style.

## Priority order
1. User-selected style: {visual_style}
2. Confirmed image / UI reference: {ui_ref}
3. PLAYER 1 identity reference: {player1_ref}
4. PLAYER 2 identity reference: {player2_ref}
5. Height/body comparison reference: {height_ref}
6. Fixed source video event framework

## Reference roles
- {ui_ref}: confirmed first image; locks UI layout, menu hierarchy, color system, typography scale, button structure, character-game integration, overall composition logic.
- {player1_ref} / {player2_ref}: identity anchors; lock exact face, hairstyle, glasses if present, facial proportions, body identity, and nickname mapping to {player1_name} / {player2_name}.
- {height_ref}: body comparison anchor; locks the visible contrast between the two players, prevents identical body proportions.

## Global style baseline
整体画风必须优先服从用户选择:{visual_style}。保留固定基准:游戏主菜单 UI、高品质游戏宣传片质感、UI 与角色深度融合、现代商业游戏 UI 设计、极强视觉冲击力、画面简洁干净、避免过度装饰。其余视觉层面根据 {visual_style} 动态拓展:角色画风、表情气质、服装语言、色彩系统、灯光冷暖、UI 材质、按钮图标、字体质感、城市加载后的世界风格。

## Palette system
根据 {visual_style} 推导视频全程色彩,保持 UI 色彩联动:xx 色作为主体背景/世界主色、xx 色作为 UI 主体颜色、xx 色作为文字颜色、xx 色作为功能强调色、红色作为危险/退出/警示提示色;整体颜色控制在 5 种以内;高对比撞色、鲜明现代、符合 {visual_style} 的色彩语言。视频中的菜单、装备面板、玩家卡、按钮、HUD、加载条、图标和文字都必须沿用同一色彩系统,不得随机新增无关颜色。

## Character identity and style lock
PLAYER 1:五官信息参考 {player1_ref},必须保留脸、人脸比例、发型、眼镜(如有)、个人身份和 {player1_name} 昵称对应关系;表情、画风、服装和机械装备按 {visual_style} 动态优化。始终位于左侧,偏高挑/修长/敏捷,装备色为功能强调色,机械爪轻量、纤细、灵活。
PLAYER 2:五官信息参考 {player2_ref},必须保留脸、人脸比例、发型、个人身份和 {player2_name} 昵称对应关系;表情、画风、服装和机械装备按 {visual_style} 动态优化。始终位于右侧,偏矮壮/宽厚/力量型,装备色为琥珀红或与危险/力量提示一致的暖色,机械拳厚重、宽大、有重量。
禁止角色身份交换、脸部互相融合、昵称交换、两人体型趋同。

## Fixed timeline framework

### [0秒–2秒] — 双人主菜单
高角度俯拍大全景,延续 {ui_ref} 构图逻辑;镜头从上方轻微下压并缓慢推进。PLAYER 1({player1_name})与 PLAYER 2({player2_name})并排坐在画面中央,1 在左、2 在右,抬头看向摄像机,只有自然呼吸、眨眼和轻微身体动作。
UI:左上玩家资料卡准确显示 "PLAYER 1" "{player1_name}" "READY";顶部中央或左上双卡系统第二张资料卡准确显示 "PLAYER 2" "{player2_name}" "READY";右侧纵向菜单准确显示 "START NEW GAME" "CONTINUE" "SETTINGS" "EXIT GAME","CONTINUE" 是视觉中心和主高亮按钮。
动态风格填充:主菜单背景、地面纹理、按钮形态、图标、字体、边框、辉光和贴纸质感全部按 {visual_style} 优化,保留 {ui_ref} 的布局和层级。
声音:菜单环境音、轻微 UI hover 声、点击前的低频电子氛围;若生成无音频则忽略声音执行。

### [2秒–4秒] — PLAYER 1 右臂配置
中景,镜头从主菜单平滑推近 PLAYER 1 右臂,PLAYER 2 仍在背景中可见、不消失、不变形。
UI:右侧主菜单收缩滑出;带功能强调色识别线的 UI 面板从左侧滑入,准确显示 "PLAYER 1" "RIGHT ARM EQUIPMENT";装备列表先高亮 "PHANTOM GRIP",随后选区移至 "CHRONOS CLAW"。
动作:右袖口自动打开,轻量机械结构从前臂下方展开;手指分开,修长爪状指节滑入并逐一锁定,内部短暂露出精细线路、微型活塞和金属连接件;完成后功能强调色 LED 依次亮起。
动态风格填充:机械结构、UI 面板材质、图标、线条、锁定动画和光效按 {visual_style} 优化,必须轻量、精密、灵活,符合 PLAYER 1 身形,不改变脸、发型和服装主体。
声音:精密机械展开声、轻快 UI 切换音、细小锁定声。

### [4秒–7秒] — PLAYER 2 重型手臂配置
中景,摄影机沿两人之间平滑横移并绕向 PLAYER 2 左侧;PLAYER 1 留在背景中,轻轻观察自己完成配置的机械手。
UI:新的暖色/琥珀红识别 UI 滑入,准确显示 "PLAYER 2" "ARMAMENT CUSTOMIZATION";面板网格展示 "HAND" "FOREARM" "ELBOW" "UPPER ARM",选区快速但清晰地在四个组件间切换。
动作:左臂外套袖口分段打开,厚重前臂护板向外弹开,旧组件脱离,新型装甲沿导轨滑入;肘关节替换为厚实机械轴承,宽大机械手重新组合并锁定;过程中短暂露出粗壮线路、液压活塞和深色金属骨架;每个部件锁定时亮起低调暖色指示灯。
动态风格填充:重型机械臂、UI 面板、组件图标、材质、光效按 {visual_style} 优化,必须厚重、宽大、有力量感,与 PLAYER 1 的轻量机械爪形成清晰对比。
声音:低沉电机声、重型机械扣合声、厚重锁定反馈。

### [7秒–8.5秒] — 双人确认配置
中景拉回,镜头平滑回到双人构图,PLAYER 1 左侧、PLAYER 2 右侧。
UI:两组装备面板向画面中央汇合成共享按钮,准确显示 "CONFIRM CONFIG";按钮边框、辉光、图标和贴纸质感按 {visual_style} 优化,层级清晰、文字可读。
动作:光标点击按钮,功能强调色能量脉冲流过 PLAYER 1 机械爪,暖色/琥珀红能量脉冲流过 PLAYER 2 机械拳;所有 UI 面板快速向内收缩消失;两人同时解开交叉双腿并调整坐姿:PLAYER 1 轻盈抬起单膝、修长机械爪依次活动手指,PLAYER 2 一只脚稳稳踩地、厚重机械拳缓慢握紧。
声音:确认提示音、双色能量脉冲、UI 收缩声。

### [8.5秒–10秒] — 双人世界加载
全景,底部共享加载条出现。
UI:加载条准确显示 "LOADING",进度从 0% 快速填充至 100%;左半段用 PLAYER 1 功能强调色,右半段用 PLAYER 2 暖色/力量色;HUD 和加载条的形态、边框、纹理、字体按 {visual_style} 优化,必须清晰可读。
环境转化:黄色平面环境连续转化为游戏世界——警戒线变成真实街道道路标记和施工围挡;墨迹/纹理化为潮湿路面反光或符合 {visual_style} 的地面光影;平面涂鸦扩展成建筑墙面喷绘;黑色背景区域形成城市阴影和深巷入口。
关键约束:转化必须连续自然,不使用硬切,不用烟雾遮挡,不改变两位角色身份。
声音:加载上升音、环境从菜单氛围过渡到城市氛围。

### [10秒–15秒] — 双人进入游戏世界
大全景转第三人称跟拍;加载 100% 瞬间两名角色同时起身;摄影机平滑下降并绕到两人身后,变成稳定第三人称双人合作视角。
世界风格:完整游戏世界按 {visual_style} 动态生成;保留进入世界结构:密集建筑、道路、标志灯、招牌、人群或动态背景、快速经过的载具、电线、工业管道、远处城市天际线;世界材质、建筑形态、招牌设计、光影和动效必须服从 {visual_style},不让源默认赛博朋克风格压过用户选择(除非用户选的就是赛博朋克)。
角色关系:清楚展示两人背影和体型差异——PLAYER 1 左侧高挑修长、轻量机械爪自然垂下,PLAYER 2 右侧矮壮宽厚、重型机械拳微微抬起;PLAYER 1 率先迈步,PLAYER 2 紧随其后,并肩进入街道。
HUD:淡入;右上角小地图;左下角两组独立状态栏 "{player1_name}" "{player2_name}",分别使用各自功能强调色/暖色;前方街道中央出现共享任务标记。
声音:城市环境氛围、远处载具声、脚步声、HUD 淡入提示音。

## Negative constraints
No third player, no female character unless explicitly requested by user, no duplicated character, no character swapping, no username swapping, no merged bodies, no identical body proportions, no changing faces, no changing hairstyles, no changing identity, no missing PLAYER 1, no missing PLAYER 2, no split screen, no hard cuts, no random camera shake, no floating body parts, no gruesome dismemberment, no weapon, no excessive neon unless selected by user style, no purple background unless selected by user style, no unreadable UI, no random letters, no misspelled usernames, no extra menu options, no official game logo, no copied branded interface, no watermark.
---

## 一致性锁定

- 用户选择的视觉风格是最高优先级,锁定后用 `memory.remember` 存档;任何段落(色彩、UI、字体、图标、人物)与风格冲突时服从风格,但不许改动固定布局框架。
- 玩家名、游戏名、角色身份锚点(脸型轮廓、发型、眼镜、五官比例)一次锁定,首图与视频 prompt 中逐字一致;禁止身份交换、昵称交换、体型趋同。
- 色彩系统五色以内且全片联动:首图确立的主色/UI 色/文字色/功能强调色/危险红,视频 prompt 逐字沿用,不新增无关颜色。
- 确认首图是视频生成的 UI 参考基准({ui_ref});首图未确认前不得提交视频。

## 红线

1. **重跑任一镜/首图(重新 `engine.submit` 已生成过的节点)前必须 `ask.user` 确认**,说明重跑原因与档位。
2. **节点 id 一律用 `canvas.list_nodes` 现拉**,禁止凭记忆引用旧 id。
3. **不静默跳过失败镜头/失败首图**:生成失败必须如实报告原因,给出修正方案(按「常见失败修正」改写 prompt)并经用户确认后重试。
4. 首图未获用户确认前,禁止提交视频生成;「跳过确认」只对本次运行生效。
5. 不虚构工具能力:本技能只涉及 image-gen 首帧与 h3.c 视频生成,不承诺 UI 可交互 Demo 或多页面界面。
