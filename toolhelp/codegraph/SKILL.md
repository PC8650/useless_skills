---
name: codegraph
description: Query the CodeGraph knowledge graph to explore code architecture, trace call chains (callers/callees), assess change impact (blast radius), or manage index status via the codegraph CLI.
user-invocable: true
---
# CodeGraph 使用指南

[CodeGraph](https://github.com/colbymchenry/codegraph) 是专为 AI Coding Agent 设计的本地代码知识图谱引擎（基于 Tree-sitter AST 与嵌入式 SQLite，无外部服务依赖）。在探索代码结构、调用链路和改动影响范围时，优先使用 CodeGraph 替代逐文件阅读或全局文本搜索。

## 1. 协议选择（MCP 优先原则）

处理代码分析与探索任务时，按以下优先级选择交互通道：

### 模式 A（优先）：直接调用 MCP 工具 `codegraph_explore`
当环境工具列表中包含 `codegraph_explore` 时，直接调用该 MCP 工具（**`projectPath` 为必填，所有调用 MUST 携带**）：
* 探索流程与调用链：`codegraph_explore(query: "登录认证流程与调用关系", projectPath: "<目标项目绝对路径>")`
* 查找调用方/被调用方：`codegraph_explore(query: "who calls handlePayment", projectPath: "<目标项目绝对路径>")`
* 评估改动影响范围：`codegraph_explore(query: "impact of UserProfile schema", projectPath: "<目标项目绝对路径>")`
* 跨目录指定项目：`codegraph_explore(query: "...", projectPath: "<另一项目绝对路径>")`
* 规则：获取结果后不要使用全局文本搜索工具二次验证。

> **工具名说明**：`codegraph_explore` 是 **codegraph MCP server 暴露的裸工具名**；不同宿主可能为其加前缀或做字符转换。**MUST** 以当前会话实际挂载的工具名为准，不要硬编码宿主特定格式。

### 模式 B（降级与运维）：终端 CLI 命令行
当未挂载 MCP 工具，或需执行关闭遥测、初始化、重建、同步等运维操作时，在终端运行 CLI。命令速查与运维语义见 `references/cli-commands.md`。

## 2. CLI 运行环境与前置配置

### 步骤 0：强制关闭遥测（隐私保护）
CLI 首次使用时必须关闭遥测，防止写入统计缓存：
```bash
"$CG" telemetry off
```
或在当前会话设置环境变量 `CODEGRAPH_TELEMETRY=0`。

### 步骤 1：便携路径定位（记为 $CG）
依次按以下优先级确认可执行文件路径：
1. 检查环境变量 `$CODEGRAPH_BIN`。
2. 检查宿主 MCP 配置，获取路径：读取当前 Agent 宿主的 MCP 配置文件（用户级与项目级），取 codegraph 服务条目中的 `command` 字段作为 `$CG`。不同宿主配置位置与字段名不同（如 `mcpServers` / `servers` 等），以实际宿主为准；若无法确定配置文件位置，可先查看当前会话已挂载的 MCP 服务列表。
3. 若均未找到，直接向用户询问一次路径并在本会话中固定使用，严禁执行 `find /` 全盘递归搜索。

### 步骤 2：目标工作目录判定（记为 `<project-root>`）

所有针对代码库的命令必须在目标项目根目录下执行，索引库自动保存在 `<project-root>/.codegraph/`：
```bash
cd <project-root> && "$CG" <command>
```

**MUST 先判定 `<project-root>`，再执行任何查询**。按以下优先级确定：

1. **用户显式指定**：用户在本轮对话中给出的项目路径/名称，直接采用（若为相对路径，基于当前工作目录解析）。
2. **当前工作目录**：若当前工作目录本身是项目根（存在 `.codegraph/` 或 `.git/`），直接采用。
3. **向上回溯**：从当前工作目录逐级向上查找最近的 `.codegraph/` 或 `.git/`，命中即为其项目根（与 codegraph 自身的索引解析规则一致）。
4. **多项目/未命中时**：若当前目录既无索引也不在项目内（如位于工作区父目录），**MUST 先枚举候选项目再让用户确认**，禁止自行猜测：
   - 列出当前目录下含 `.codegraph/` 的子目录（已索引项目）；
   - 若无已索引项目，列出含 `.git/` 的子目录（待索引项目）；
   - 将候选列表交给用户选择，或询问目标项目路径。
5. **均未找到**：向用户询问一次项目路径，并在本会话中固定使用；**严禁**全盘递归搜索。

**MCP 模式下的对应关系**：`codegraph_explore` 的 `projectPath` 参数即上述判定结果（目标项目绝对路径）。该参数**为必填**（实测：省略会被运行时校验拒绝），**MUST** 始终显式传入。

**`projectPath` 解析规则（实测）**：
- 传**仓库根**或其**任意子目录**均可，工具会向上查找最近的 `.codegraph/`（实测：根与深层子目录返回结果完全一致）；
- 传**未索引目录**或**仅含已索引子项目的父目录**时，**不会**自动下钻到子项目，而是返回提示 `isn't indexed with codegraph ... don't call codegraph for it again this session`；
- 因此**多项目场景 MUST 逐个传入具体项目路径**，不能传工作区父目录。

**未索引时的处置**：若目标项目存在 `.git/` 但无 `.codegraph/`，说明尚未建立索引。`codegraph init` 会写入索引目录，属**用户决策**——**MUST** 先告知用户并征得同意，不得自行运行。

## 3. 参考文档索引

| 文档 | 内容 |
|:---|:---|
| `references/cli-commands.md` | CLI 命令速查表、标准执行流程、运维命令与 `--force` 语义、**索引健康度检查与自动同步机制**、注意事项 |
| `references/usage-guide.md` | 跨仓库全链路分析规范、结果规模预防与精确控制（含受控回退与调用记录要求） |
| `references/params-quickref.md` | 参数速查：MCP/CLI 参数与默认值、收窄手段效力排序、实战速查表、**跨版本兼容性兜底流程**、陷阱索引（⚠P#） |
| `references/pitfalls.md` | 陷阱清单：P1–P12 的症状/根因/正确做法/关键证据、症状反向索引 |
| `references/measurements.md` | 实测数据矩阵：`query` 匹配算法、体积实测完整矩阵、**版本升级后高危复测清单** |

**使用要求（MUST）**：执行代码探索/影响分析前，先读 `references/usage-guide.md`；需要 CLI 命令或索引运维时，先读 `references/cli-commands.md`；遇到结果超限时，先读 `references/params-quickref.md` 选参数，**凡参数带 ⚠P# 标记 MUST 再读 `references/pitfalls.md` 对应条目**；结果为空/漏报/异常时，直接读 `references/pitfalls.md` §0 症状索引；需要精确实测数字或版本升级复测时，读 `references/measurements.md`。

**索引新鲜度（MUST）**：codegraph 在 **MCP 模式下自动同步**（文件变更约 0.5s 生效，实测），**Agent 无需在工作前后手动更新**；仅**纯 CLI 模式**（未挂载 MCP）需先执行 `"$CG" sync`。详见 `references/cli-commands.md` §4.1。

**版本兼容（MUST）**：本文档与 references 中的参数、默认值、行为结论均基于**参照版本**实测。若当前 CodeGraph 版本与参照版本主次版本不同，**MUST** 先按 `references/params-quickref.md` §5「跨版本兼容性兜底」重新校验，并按 `references/measurements.md` §3 逐条复测 P1–P12，**不得直接套用**文档中的默认值与阈值。
