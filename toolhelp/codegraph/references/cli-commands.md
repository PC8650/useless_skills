# CodeGraph CLI 命令与运维参考

> 适用场景：未挂载 MCP 工具，或需执行索引运维（初始化、重建、同步、解锁、遥测）时，通过终端 CLI 操作 CodeGraph。
>
> 前置：已完成 SKILL.md 的「CLI 运行环境与前置配置」（遥测关闭、`$CG` 路径定位、`<project-root>` 判定）。
>
> 参数与默认值以本机实测为准（参照版本 1.6.x）；CodeGraph 迭代较快，**执行前建议用 `codegraph <command> --help` 核对当前版本的实际参数**。
>
> **版本兼容兜底**：若当前版本与参照版本主次版本不同，**MUST** 先按 `references/params-quickref.md` §5「跨版本兼容性兜底」重新校验，不得直接套用本文档参数。

---

## 1. 命令速查表

| 命令格式 | 适用场景 | 常用参数 |
|:---|:---|:---|
| `cd <project-root> && "$CG" explore <query>` | 业务逻辑/调用路径/架构综合探索（单次返回源码与链路） | `--max-files <n>`；支持自然语言或符号 |
| `cd <project-root> && "$CG" impact <symbol>` | 改动前的爆炸半径（Blast Radius）分析 | **`-f <file>`**（首选收窄）, `--depth <n>`, `--json` |
| `cd <project-root> && "$CG" callers <symbol>` | 查找上游调用方 | **`-f <file>`**（首选收窄）, `--limit <n>`, `--json` |
| `cd <project-root> && "$CG" callees <symbol>` | 查找下游调用依赖 | **`-f <file>`**（首选收窄）, `--limit <n>`, `--json` |
| `cd <project-root> && "$CG" node <symbol\|path>` | 查看具体符号定义源码或文件结构详情 | `--file <路径>`（文件模式，**路径作为其值**）, `--offset`, `--limit`, `--symbols-only`（**仅文件模式生效**） |
| `cd <project-root> && "$CG" query <name>` | 按名称模糊搜索符号列表 | `--kind <method\|class\|enum\|...>`, `--limit`, `--json` |
| `cd <project-root> && "$CG" context <task>` | 按任务构建上下文（符号+关系+代码块） | `--max-nodes <n>`, `--no-code`, `--format <md\|json>` |
| `cd <project-root> && "$CG" files` | 从索引输出项目文件结构（先摸清布局） | `--max-depth <n>`（**必加**，默认输出 437KB）, `--filter <dir>`, `--pattern <glob>`, `--format <tree\|flat\|grouped>`（**仅 tree 支持 `--max-depth`**）, `--no-metadata`, `--json` |
| `cd <project-root> && "$CG" affected [files...]` | 根据修改的文件查找受影响的测试/依赖文件 | `--stdin`, `--filter <glob>`, `--depth <n>`（**直接影响结果数，默认 5 可能漏报**）, `-q/--quiet`（仅输出路径）, `--json` |
| `cd <project-root> && "$CG" status` | 查看图谱健康度与符号/文件/关系统计 | `--json`；**路径用位置参数** `status [path]`（不支持 `-p`） |
| `cd <project-root> && "$CG" init` | 为目标项目初次建立索引数据库（**需用户同意**） | 运维类 `-f` 见 §3；`-y/--yes`（非交互）、`-v/--verbose`；**路径用位置参数** `init [path]` |
| `cd <project-root> && "$CG" sync` | 增量同步自上次索引以来的变更（**MCP 模式自动执行，纯 CLI 需手动**） | `--quiet`；**路径用位置参数** `sync [path]` |
| `cd <project-root> && "$CG" index` | 全量重新扫描并重建图谱（**本身即全量重建**） | 运维类 `-f` 见 §3；`-q/--quiet`、`-v/--verbose`；**路径用位置参数** `index [path]` |
| `cd <project-root> && "$CG" unlock` | 移除阻塞索引的陈旧锁文件 | |
| `"$CG" daemon` | 管理后台守护进程（交互式选择停止） | |
| `"$CG" upgrade [version]` | 升级 CodeGraph 本体 | `--check`（仅检查版本）、`-f/--force`（已是最新也重装） |
| `"$CG" telemetry off` | 永久关闭匿名数据上报 | |
| `cd <project-root> && "$CG" uninit` | 移除当前项目的 `.codegraph/` 索引 | 运维类 `-f` 见 §3；**路径用位置参数** `uninit [path]` |

注：
- **参数语义与默认值**：见 `references/params-quickref.md` §2（本表仅列**参数名**与**安全级警告**）。
- **`--json` 支持矩阵（实测）**：`callers` / `callees` / `impact` / `query` / `files` / `affected` / `status` **支持**；`explore` / `node` / `context` **不支持**（传了会报 `unknown option '--json'`）。
- **`-f` 短选项含义因命令而异（易误用，MUST 区分）**：`callers`/`callees`/`impact`/`node` → `--file`（文件收窄）；`affected` → `--filter`（glob 过滤）；`context` → `--format`（输出格式）；`init`/`index`/`uninit` → 运维语义，见 §3。**跨命令套用前先看 `--help`**。
- **`path` 参数形式不统一（易误用，MUST 区分）**：`explore`/`callers`/`callees`/`impact`/`query`/`node`/`context`/`files`/`affected` 用 **`-p, --path <path>`**；`status`/`init`/`sync`/`index`/`uninit` 用 **位置参数 `[path]`**（传 `-p` 会报 `unknown option '-p'`）。
- **`--kind` 取值**：有效取值与 `func` 陷阱见 `references/pitfalls.md` P1。

---

## 2. 标准执行流程

> **索引新鲜度（MUST）**：MCP 模式下文件变更约 0.5s 自动同步（见 §4.1），**无需手动更新**；纯 CLI 模式下 **MUST** 先执行 `"$CG" sync`。

1. 确认已执行 `"$CG" telemetry off`。
2. 确认目标项目已初始化：执行 `cd <project-root> && "$CG" status`，若无索引则执行 `cd <project-root> && "$CG" init`（**需用户同意**）。
3. 探索代码结构与链路：优先使用 `codegraph_explore` MCP 工具，或运行 `cd <project-root> && "$CG" explore "<query>"`。
4. 修改代码前评估影响：运行 `cd <project-root> && "$CG" impact <symbol_name>`。
5. 实施代码修改。
6. 检查受波及范围：运行 `cd <project-root> && "$CG" affected $(git diff --name-only)`。

---

## 3. 运维命令与 `--force` 语义（易误用，MUST 区分）

| 命令 | `--force` / `-f` 的真实语义 | 说明 |
| :--- | :--- | :--- |
| `codegraph init [path]` | `-f` = **即使路径像家目录/盘根也执行**（安全覆盖开关） | 索引默认就会构建，无需额外开关 |
| `codegraph index [path]` | `-f` = **同上**（安全覆盖开关） | **`index` 本身就是全量重建**，与 `init` 结果一致；`--force` **不是**"强制重建"开关 |
| `codegraph uninit [path]` | `-f` = **跳过确认提示** | 删除 `.codegraph/` 目录 |
| `codegraph sync [path]` | `-q` = 静默（供 git hook 用） | 增量同步自上次索引以来的变更 |
| `codegraph unlock [path]` | — | 移除阻塞索引的陈旧锁文件 |
| `codegraph daemon` | — | 管理后台守护进程（交互式选择停止） |
| `codegraph upgrade [version]` | — | 升级 CodeGraph 本体 |

---

## 4. 索引健康度检查与自动同步

### 4.1 自动同步机制（实测，重要）

**codegraph 在 MCP 模式下自动同步，Agent 无需手动更新**：

| 项 | 实测结果 |
| :--- | :--- |
| **触发者** | **MCP 服务进程**（`codegraph serve --mcp`），非 CLI |
| **证据** | `.codegraph/writer.pid` 指向的 PID 即 MCP 服务进程（命令行含 `serve --mcp`） |
| **默认状态** | **启用**（`--no-watch` 可禁用） |
| **同步延迟** | **约 430~490 ms**（3 次实测：491/437/428 ms） |
| **CLI 是否自带** | ❌ **否**（纯 CLI 场景需手动 `codegraph sync`） |

> **结论**：
> - **MCP 模式**：文件变更后约 0.5s 自动同步，**Agent 无需在工作前后手动更新**；
> - **纯 CLI 模式**（未挂载 MCP）：**MUST** 在查询前手动执行 `codegraph sync`，否则读到陈旧索引；
> - **禁用 watcher 的场景**（如 WSL2 `/mnt` 慢文件系统）：MCP 启动参数加 `--no-watch`，此时同样需手动 `sync`。

### 4.2 健康度检查

- `codegraph status`：查看符号/文件/关系统计（实测输出 `Files` / `Nodes` / `Edges` / `DB Size` 等），确认索引未损坏；
- 大项目索引缺失：`codegraph init`（用户决策，Agent 不自行运行）。

> **未验证项（MUST NOT 当作已知事实）**：
> - **`[stale]` 标记**：本文档早期版本曾提及，但**实测未在输出中观察到该标记**（`explore` 输出仅含 boilerplate 中的 "stale cache" 字样，非标记）。若遇到，以实际输出为准。
> - **`codegraph.json` 自定义排除规则**：工具**无 `config` 命令**，该配置项**未经实测验证**；需自定义排除时 **MUST** 先查 `codegraph <command> --help` 或官方文档确认。

---

## 5. 注意事项

1. **单工具原则**：CodeGraph 在 MCP 协议下仅暴露 `codegraph_explore` 单一工具（**已实测验证**），不要调用已废弃的细分 MCP 工具。
2. **默认排除策略**：默认忽略 `node_modules`、`vendor`、`dist`、`build`、`.git`、`.venv` 及 `.gitignore` 包含的内容（**已实测验证**：`files --pattern "*node_modules*"` 与 `"*.git*"` 均无结果）。
3. **Web 路由感知**：内置支持主流 Web 框架的路由与 Controller 映射（**仅 Spring 已实测验证**：`query --kind route` 可返回形如 `POST /<path>/<method>` 的路由节点；其他框架未验证）。
4. **版本兼容**：本文档参数基于参照版本实测；版本变化时 **MUST** 按 `references/params-quickref.md` §5 重新校验。
