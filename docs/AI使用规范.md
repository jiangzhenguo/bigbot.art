# BigBotArt AI 使用规范(人类协作者版)

> 本文面向**使用 AI 工具开发本项目的人**:怎么给 AI 派活、怎么验收、哪些事必须人来把关。
> 面向 AI 代理本身的强制规则在根目录 `AGENTS.md`,两者配套使用。

## 1. 适用范围与工具映射

| 工具 | 读取的规范文件 | 说明 |
|---|---|---|
| Claude Code | `CLAUDE.md` + `AGENTS.md` | CLAUDE.md 是其原生入口 |
| Codex / DSH / 其他通用代理 | `AGENTS.md` | 行业标准入口,放仓库根目录 |
| Cursor / Copilot | 建议 `.cursor/rules` 软链到 `AGENTS.md`(待建) | 暂无配置,见 §6 待办 |

原则:**单一事实来源**。规则只维护一份(AGENTS.md),其他工具的入口通过链接/引用指向它,避免多份漂移——`docs/节点手册_副本.md` 就是反例。

## 2. 给 AI 派活的正确姿势

### 2.1 好任务的三要素
1. **指明进程边界**:"改 renderer 的画布交互" / "在主进程加一个 IPC" —— 本项目三进程隔离,边界说清 AI 就不会乱伸手
2. **指明验证方式**:"改完跑 `pnpm typecheck`,dry-run 下验证" —— 把验收标准写进任务里
3. **指明联动范围**:涉及契约/协议时,提醒"按 AGENTS.md §2 的联动清单核对"

### 2.2 按风险分级派活

| 级别 | 例子 | 把关方式 |
|---|---|---|
| 🟢 低 | 文档、样式、注释、新增独立工具函数 | 抽查 |
| 🟡 中 | 新节点类型、新 IPC 方法、新 Provider | 逐文件 review + typecheck + dry-run 跑通 |
| 🔴 高 | 改 `protocol.ts` 协议、改 `domain.ts` 持久化字段、动 dry-run 判定、动密钥/凭据链路 | **必须人工逐行 review**,且要求 AI 先给方案再动手 |

### 2.3 禁止对 AI 说的模糊指令
- ❌ "优化一下这个项目" → AI 会无边界重构
- ❌ "跑一下看看效果" → 可能触发真实推理(144GB 模型加载)
- ❌ "把报错都修了" → 容易引入静默吞错(违反红线 R6)
- ✅ 替代:给定具体文件/函数 + 可验证的完成标准

## 3. 安全与成本红线(人来把,别信 AI 自觉)

1. **密钥**:任何 Key 只进 `.env`(已 gitignore)或 macOS 钥匙串(走 `credentialSet` IPC,不落盘)。提交前 `git status` 扫一眼
2. **真实推理**:代码默认 dry-run(`BIGBOTART_DRYRUN !== '0'` 才真实),但注意根脚本 `pnpm dev` 显式设了 `=0`!**日常开发用 `pnpm dev:dry`**;要真实出片再 `pnpm dev`,且确认模型就绪、接受分钟级耗时
3. **用户数据**:`.bigbotart/`、outputs 目录是用户资产,任何"清理/重置"操作先备份
4. **依赖**:AI 提议装新依赖时,问清用途、体积、license 再批;Electron 项目对包体积敏感

## 4. 验收 Checklist(AI 交付后逐项过)

- [ ] `pnpm typecheck` 全 workspace 通过
- [ ] 改了契约 ⇒ shared / main / preload 三处 diff 都在(AGENTS.md §2.1)
- [ ] 改了协议 ⇒ method 枚举、worker 分发、manager 调用三处都在(AGENTS.md §2.2)
- [ ] dry-run 下功能冒烟通过(必要时用 mock Provider 做端到端)
- [ ] `git status` 无意外文件(尤其 `.env`、`outputs/`)
- [ ] 架构/命令/环境变量变了 ⇒ CLAUDE.md 已同步
- [ ] 无新增 `catch` 空块、无 `console.log` 替代日志总线

## 5. 多 AI 协作防漂移

- 不同 AI 工具改同一区域前,先 `git status` 确认工作区干净;当前仓库长期挂着 20+ 未提交文件,**这是 AI 上下文污染的重灾区**——每个任务开始前先提交或 stash
- 分支按 `git-branch-workflow`(时间戳_jzgX)开;AI 不 push、不改历史,push 前走人工
- 发现某条规则 AI 反复违反 ⇒ 把它写进 `AGENTS.md` 红线或联动清单,而不是每次口头纠正

## 6. 待办(规范落地项)

- [ ] 建 `.cursor/rules`(软链 AGENTS.md)与 `.claude/` 目录,统一各工具入口
- [ ] 删除或归档 `docs/节点手册_副本.md`,消除双事实源
- [ ] 评估把根 `pnpm dev` 的 `BIGBOTART_DRYRUN=0` 改回默认 dry-run(当前与 CLAUDE.md 表述矛盾,是最高频误操作点)
- [ ] 为 §4 验收清单加一条 CI(typecheck + 密钥扫描),减少人工兜底
