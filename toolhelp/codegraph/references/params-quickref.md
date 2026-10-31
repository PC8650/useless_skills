# CodeGraph 参数速查（结果规模控制）

> 适用场景：需要查阅 CodeGraph 的**具体参数、默认值、收窄手段效力排序**时。
>
> **规则清单（A~H）见 `references/usage-guide.md` §2**——本文档提供**参数、默认值、实测数据**与**参数级约束（MUST）**；**流程级规则**（如何分解查询、如何回退）不在此重复。
>
> **读取决策（按需，不必全读）**：
>
> | 你的问题 | 读哪个文件 |
> | :--- | :--- |
> | 这个参数叫什么、默认值多少、怎么收窄 | **本文件**（`params-quickref.md`） |
> | 结果为空 / 漏报 / 体积暴涨 / 参数不生效 | `pitfalls.md`（P1–P12 陷阱） |
> | 要精确实测数字 / 版本升级后复测 | `measurements.md`（完整矩阵 + 复测清单） |
>
> 配套文档：**陷阱见 `references/pitfalls.md`**（本文档参数表中的 ⚠P# 即指向该文件的陷阱编号）；**完整实测矩阵见 `references/measurements.md`**。
>
> **硬性要求（MUST）**：本文档参数表中凡带 ⚠P# 标记的参数，**使用前 MUST 先读 `pitfalls.md` 对应条目**——这些参数存在静默失败、语义偏差或体积失控行为，仅按本文档默认值使用会得到错误结论。
>
> 参数与默认值以本机实测为准（参照版本 1.6.x）；CodeGraph 迭代较快，**执行前建议用 `codegraph <command> --help` 核对当前版本的实际参数**。
>
> **版本兼容兜底**：若当前版本与参照版本主次版本不同，**MUST** 先按本文档 §5「跨版本兼容性兜底」重新校验，不得直接套用本文档数值。

---

## 0. 效力排序与阈值

> 核心原则（为何不能降级）见 `references/usage-guide.md` §2。

**目标**：使单次 codegraph 调用结果规模 ≤ 当前宿主的 MCP 结果截断阈值。该阈值**因宿主而异**（不同 Agent 宿主对 MCP 文本结果的截断上限不同，常见在 8KB~20KB 区间，也可能更大），**MUST** 以当前宿主的实际阈值为准，不要照搬本文档的示例值。

### 0.1 收窄手段效力排序（实测，MUST 按此优先级）

在 3,186 文件 / 101,302 节点的实测项目上，各手段对输出体积的影响差异极大：

| 优先级 | 手段 | 实测效果 | 说明 |
| :--- | :--- | :--- | :--- |
| **1（首选）** | **查询精度**（精确符号名/文件名） | 11KB vs 27KB | 决定性因素 |
| **2（首选）** | **`-f/--file` 文件收窄** | 249KB → 262B（**约 950 倍**） | 对 `callers`/`callees`/`impact` 等符号类命令**最有效**，见 §2 |
| 3（辅助） | `--limit` | 249KB → 232KB（约 7%） | 仅截断列表尾部，**不能**控制主体体积（⚠P3） |
| 4（辅助） | `--max-files` / `maxFiles` | 27KB → 26KB（约 2.5%） | 影响很小，**不是**主要手段（⚠P7） |

**结论**：**MUST** 优先用「精确符号名 + `-f` 文件收窄」；`--limit` 与 `maxFiles` 仅作辅助兜底。

---

## 1. MCP 工具 `codegraph_explore`（首选通道）

官方参数形状：`{ query: string; maxFiles?: number; projectPath: string; }`

| 参数 | 作用 | 用法 |
| :--- | :--- | :--- |
| `query` | 探索查询（自然语言或符号名/文件名集合） | 必填；**MUST 用精确符号名**。**精度技巧**：用**文件名（带扩展名）**比用**符号名**精度高 3.5~8.3 倍（实测数据见 `measurements.md` §2.1） |
| `maxFiles` | 限制返回源码的文件数上限（**实测默认 8**，非工具声明的 12） | **辅助手段**，影响有限（见 §0.1）；可预设 `maxFiles: 3` 作兜底，但**不要指望它解决超限**（⚠P7） |
| `projectPath` | 目标项目绝对路径（解析最近的 `.codegraph/`） | **必填**（实测：省略会被运行时校验拒绝，报 `must have required properties projectPath`）。工具描述虽称"可省略则用会话默认项目"，但**实际校验强制要求**，**MUST** 始终显式传入 |

---

## 2. CLI 命令参数表（MCP 不可用或需精确收窄时）

> **⚠ 列说明**：带 ⚠P# 的命令存在已知陷阱，**使用前 MUST 读 `pitfalls.md` 对应条目**。

| 命令 | 收窄相关参数 | 默认值 | 用途 | 陷阱 |
| :--- | :--- | :--- | :--- | :--- |
| `codegraph explore <query>` | `--max-files <n>` | **8** | 限制返回源码文件数，与 MCP `maxFiles` 等价；**辅助手段**。注：传 `0` 等同默认 8（非"不返回源码"） | ⚠P7 |
| `codegraph callers <symbol>` | **`-f, --file <path>`** / `-l, --limit <n>` | 20 | **`-f` 为首选收窄**（按文件路径/后缀限定符号定义）；`--limit` 为 **per-definition**（每个定义最多 N 个 caller），**不减少定义数** | ⚠P2 P3 P4 |
| `codegraph callees <symbol>` | **`-f, --file <path>`** / `-l, --limit <n>` | 20 | 同上（`--limit` 亦为 per-definition） | ⚠P2 P3 P4 |
| `codegraph impact <symbol>` | **`-f, --file <path>`** / `-d, --depth <n>` | 2 | **`-f` 为首选收窄**；`--depth` 控制爆炸半径遍历深度。注：`--depth 0`/`1`/负数均等同最小深度（不报错） | ⚠P2 P4 |
| `codegraph query <name>` | `-l, --limit <n>` / `-k, --kind <kind>` | 10 | 符号模糊搜索条数 + 类型过滤；**MUST 预设 `--limit 5 --kind class`**。注：`--limit` 在 `--kind` **过滤后**生效（返回数 = `min(limit, kind 命中数)`）。**匹配算法**：子串 + 编辑距离≤2，**大小写不敏感**（见 `measurements.md` §1.1） | ⚠P1 |
| `codegraph node <symbol>` | `--file <file>` / `--offset <n>` / `--limit <n>` / `--symbols-only` | — | **文件模式**：`node --file <路径> [--symbols-only] [--offset N --limit M]`；大文件**MUST 先 `--symbols-only` 再分段读**（写法陷阱见 ⚠P11） | ⚠P10 P11 |
| `codegraph context <task>` | `-n, --max-nodes <n>` / `--no-code` / `-f, --format <md\|json>` | **20** | 按任务构建上下文（符号+关系+代码块）；`--no-code` 仅出结构（实测 4KB→1KB）。注：`--max-nodes` **只接受正整数**，传 `0`/`-1` 会报错 | ⚠P2 |
| `codegraph files` | `--filter <dir>` / `--pattern <glob>` / `--max-depth <n>` / `--no-metadata` / `-j, --json` | tree | 从索引输出文件结构，用于先摸清项目布局。**默认输出极大（实测 3,186 文件项目达 437KB），MUST 先加 `--max-depth` 收窄**；**`--format flat`/`grouped` 忽略 `--max-depth`，禁止使用**（⚠P9） | ⚠P8 P9 |
| `codegraph affected [files...]` | `-d, --depth <n>` / `-f, --filter <glob>` / `--stdin` / `-q` / `-j, --json` | 5 | 按改动文件找受影响的测试文件。**`--filter` 会替换默认的 test 过滤**（见 ⚠P5）。注：`--depth` **直接影响结果数**（见 ⚠P6） | ⚠P2 P5 P6 |
| `codegraph status` | `-j, --json` | — | 索引健康度统计 | — |
| `codegraph init` / `sync` / `index` / `uninit` | 运维类 `-f` 语义见 `references/cli-commands.md` §3 | — | 索引运维 | ⚠P12 |

> **`-f` 短选项含义与 `--json` 支持矩阵**：见 `references/cli-commands.md` §1 注。
>
> **`path` 参数形式不统一（易误用）**：`explore`/`callers`/`callees`/`impact`/`query`/`node`/`context`/`files`/`affected` 用 **`-p, --path <path>`**；`status`/`init`/`sync`/`index`/`uninit` 用 **位置参数 `[path]`**（传 `-p` 会报 `unknown option '-p'`）。详见 ⚠P12。

**`--kind` 有效取值（实测）**：`method`、`class`、`field`、`enum`、`enum_member`、`interface`、`route`、`constant`、`namespace`、`import`、`file`。

> **注意**：**没有 `func` / `function`**——传 `--kind func` 会返回空结果（不报错，静默无命中），极易误判为"符号不存在"。Java 方法请用 `--kind method`。详见 ⚠P1。

---

## 3. 大项目实战速查

> 本表仅列**参数组合**；规则依据（为何这样做）见 `references/usage-guide.md` §2。

| 场景 | 参数组合（首选） |
| :--- | :--- |
| 枚举类定位（如 `XxxStatusEnum`） | 精确符号名 `XxxStatusEnum.java` + `--kind enum` |
| 实体字段列表（宽表 130 列） | `node --file <Entity.java> --symbols-only` 先看结构，再 `node --file <Entity.java> --offset N --limit M` 读区段 |
| callers/callees 超限 | **`-f <目标文件>` 收窄** + 精确符号 `setXxxField` + `--limit 10` |
| 符号模糊搜索超限 | 精确符号名 + `query --limit 5 --kind class` |
| 查看项目文件结构 | `files --max-depth 2`（**禁止无参数 `files`**，默认 437KB） |

---

## 4. 索引健康度与运维

索引健康度检查、运维命令与 `--force` 语义详见 `references/cli-commands.md` §3–§4。

---

## 5. 跨版本兼容性兜底（MUST）

### 5.1 版本校验（使用前 MUST 执行）

```bash
"$CG" --version          # 获取当前版本
```

| 情况 | 处置 |
| :--- | :--- |
| 版本与参照版本**主次版本一致**（如 1.6.x） | 可直接使用本文档 |
| 版本**主次版本不同**（如 1.7.x / 2.x） | **MUST** 执行 §5.2 重新校验 |
| 无法获取版本 | **MUST** 执行 §5.2 重新校验 |

### 5.2 重新校验流程（版本不符时 MUST 执行）

按以下顺序校验，**任一项不符即以实测为准并更新本文档**：

1. **参数存在性**：`"$CG" <command> --help`，确认本文档列出的参数仍存在；
2. **默认值**：对关键参数（`--max-files` / `--max-nodes` / `--depth` / `--limit`）实测默认行为；
3. **高危行为**：按 `measurements.md` §3「版本升级后高危复测清单」逐条复测 P1–P12；
4. **MCP 工具 schema**：确认 `codegraph_explore` 的 `projectPath` 是否仍为必填、`maxFiles` 声明默认值是否仍与实际不符。

### 5.3 兜底原则（MUST）

- **实测优先于文档**：本文档与实测冲突时，**一律以实测为准**；
- **不静默套用**：版本不符且未重新校验时，**MUST NOT** 直接套用本文档的默认值/阈值；
- **不假设向后兼容**：**MUST NOT** 假设旧版参数在新版仍有效（如 `--kind` 取值集合可能变化）；
- **失败即降级**：若某参数在新版已不存在，**MUST** 改用 `--help` 列出的等价参数，而非强行传入。

---

## 6. 陷阱索引（参数 → 陷阱编号）

| 参数 | 陷阱编号 | 一句话风险 |
| :--- | :--- | :--- |
| `--kind` | P1 | 非法值（含 `func`）静默返回空，误判为符号不存在 |
| `-f` | P2 | 短选项含义**因命令而异**（`--file`/`--filter`/`--format`/运维） |
| `--limit` | P3 | per-definition，**不减少定义数** |
| `-f`（未命中） | P4 | 不报错，反而显示全部定义 → 结果变多要警惕 |
| `affected --filter` | P5 | glob 命中 changed file 本身时**跳过依赖遍历** |
| `affected --depth` | P6 | 默认 5 **漏报**；0/1/负数返回 0 |
| `maxFiles` / `--max-files` | P7 | 体积**非单调**（改入选集合而非截断） |
| `files`（无参数） | P8 | 默认输出 437KB |
| `--format flat/grouped` | P9 | **忽略 `--max-depth`**，收窄完全失效 |
| `node`（符号模式） | P10 | 忽略 `--symbols-only`/`--offset`/`--limit` |
| `node --file` | P11 | 路径必须是 `--file` 的**值**，否则选项失效或报错 |
| `path` 参数 | P12 | `-p` vs 位置参数**不统一** |
