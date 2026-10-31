# CodeGraph 使用规范（跨仓库分析与结果规模控制）

> 适用场景：在已建立索引的项目上执行代码探索、调用链追踪、改动影响分析，尤其是**多仓库全链路分析**与**大型项目结果规模控制**。
>
> 前置：已完成 SKILL.md 的「CLI 运行环境与前置配置」（`$CG` 路径定位、`<project-root>` 判定）。
>
> 详细参数见 `references/params-quickref.md`；陷阱见 `references/pitfalls.md`；实测数据见 `references/measurements.md`。
>
> **版本兼容**：本文档规则基于参照版本实测；版本变化时 **MUST** 按 `references/params-quickref.md` §5 重新校验。

---

## 1. 跨仓库全链路分析规范

当任务涉及多个独立代码仓库（如前端仓、后端仓、公共 RPC 仓）时，采用"契约中继法"穿透调用链。

### 1.1 能力边界（MUST 先判定）

codegraph 的索引是**单仓库**的（每个仓库独立 `.codegraph/`），**不具备**跨仓库聚合建模能力。按需求选路：

| 需求 | 是否适用 codegraph | 做法 |
| :--- | :--- | :--- |
| 跨仓库**调用链穿透**（前端→后端，靠 URL/RPC 契约中继） | ✅ 适用 | 逐仓库切换 `projectPath` / `cd`，见 §1.2 |
| 跨仓库**聚合建模**（多仓统一图谱、跨库实体关联） | ❌ 不适用 | 超出本工具能力边界，**MUST** 向用户说明并交由具备该能力的工具/流程处理 |

> **不要越界**：codegraph 无跨仓库聚合概念，无法把多个仓库的符号/关系合并为一张图。遇到此类需求时，**MUST** 明确告知用户能力边界，不得用单仓库结果冒充跨仓库结论。

### 1.2 契约中继法（codegraph 跨仓库调用链）

1. **MCP 模式下的跨仓库查询**：
   * 探索起点服务：`codegraph_explore(query: "...", projectPath: "<服务A绝对路径>")`
   * 提取调用边界契约：从输出中获取 URL 路由（如 `POST /orders`）、RPC 接口名、或 Protobuf 方法。
   * 穿透到下游服务：`codegraph_explore(query: "<提取出的URL或接口名>", projectPath: "<服务B绝对路径>")`

2. **CLI 模式下的跨仓库查询**：
   * 在服务 A 目录下执行：`cd <服务A路径> && "$CG" explore "<发起调用的入口>"`
   * 提取出远程调用特征后，切换到服务 B 执行：`cd <服务B路径> && "$CG" explore "<URL路由或实现类>"`

3. **变更影响域（跨库波及）**：
   * 若修改了服务 A 的数据结构或 API 入参，先在服务 A 计算影响面：`cd <服务A> && "$CG" impact <符号名>`
   * 确认对外接口变动后，带着变动的接口字段，到下游依赖服务的仓库中检索对应的 Client 调用点。

---

## 2. 结果规模预防与精确控制 (Result Size Prevention & Precise Control)

**核心原则 (MUST)**：`codegraph_explore` 结果过大是**查询输入不精确**的症状，而非工具能力不足。**MUST** 通过查询前预防 + 查询时精确控制使结果天然不超限，**杜绝"先返回超限再降级"的反模式**。降级（read/find/grep）是**能力退化**——一旦降级即丢失 codegraph 的符号级精确性（callers/callees/AST），违背本规范。

> 本节为**规则清单**；完整参数速查与收窄手段效力排序见 `references/params-quickref.md`，陷阱见 `references/pitfalls.md`，实测数据见 `references/measurements.md`。

### 2.1 规则清单（MUST）

| # | 规则 | 要点 |
| :--- | :--- | :--- |
| **A** | 精确符号名优先 | **禁止**模糊词（`XxxEnum`/`status`/`type`）；先取确切类名/常量名再查；**一次只查一个符号** |
| **B** | 查询参数预设收窄 | 符号类命令**优先 `-f/--file`** 再叠 `--limit 10`；`explore` 靠精确 query（`maxFiles` 仅兜底）；`query` 用 `--limit 5 --kind class` |
| **C** | 查询目标分解 | 宽泛目标拆为多个精确子查询逐个调用（调用链 4 步、实体字段 3 步） |
| **D** | Call Graph 按符号逐次 | `callers`/`callees` 单符号逐次查；同名符号**MUST** 用 `-f <文件名>` 限定 |
| **E** | 大文件分段读 | `node --file` 先 `--symbols-only` 看结构，再 `--offset/--limit` 分段读 |
| **F** | 预防失败判定 | 仅当 A~E **全部执行后**仍超限才算失败；失败时按 §2.2 记录已执行的预防策略 |
| **G** | 受控回退 ≠ 降级 | 回退是精确化补充：`read` 补全已定位文件区段 / `find` 仅定位路径 + `read` / 超出单仓库能力边界时向用户说明（见 §1.1） |
| **H** | 禁止的降级路径 | **禁止**跳过 A~E 直接 `grep`/`find` 全量扫描；**禁止**用 `grep` 替代 Call Graph |

### 2.2 关键提醒

- **反模式**：只设 `--limit 10` 而不加 `-f`，在大型项目上几乎无效（实测数据见 `references/params-quickref.md` §0.1）；
- **`--kind` 取值**：有效取值与 `func` 陷阱见 `references/pitfalls.md` P1；
- **budget 提示非配额**：`codegraph_explore` 末尾的探索提示（`Exploration guidance — advisory only, NOT a quota...`；旧版为 `Explore budget: N calls...`）是**静态建议值**，工具**不会因调用次数而拒绝执行**，可无限次调用。**MUST NOT** 因该提示就停止使用 codegraph 而降级；
- **调用记录 (MUST)**：每次调用在会话中记下检索路径（预防策略 / 受控回退 / 预防失败证明），便于审计是否跳过预防直接降级。
