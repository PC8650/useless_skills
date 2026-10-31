# CodeGraph 参数陷阱清单（P1–P12）

> **本文件包含**：症状 → 陷阱反向索引、P1–P12 陷阱的症状 / 根因 / 正确做法 / 关键证据。
>
> **本文件不包含**：参数与默认值（→ `params-quickref.md`）、完整实测矩阵与版本复测清单（→ `measurements.md`）。
>
> **何时读本文件**：结果超限 / 结果为空 / 结果漏报 / 结果异常 / 参数不生效 / 参数含义与预期不符。
>
> **何时不必读**：只是选参数、查默认值（读 `params-quickref.md` 即可）。
>
> **维护约束（MUST）**：每条陷阱标注「影响参数」，`params-quickref.md` 参数表每行标注 P#。**任一侧改动必须同步另一侧**，否则两文件漂移。

---

## 0. 症状 → 陷阱反向索引

排障时先按症状定位，再读对应 P 条目。

| 症状 | 可能陷阱 | 编号 |
| :--- | :--- | :--- |
| 查不到符号（空结果，不报错） | `--kind` 非法值静默空 / `-f` 未命中 / `affected --depth 0` | P1 P4 P6 |
| 结果漏报（少于预期） | `affected --depth` 默认 5 | P6 |
| 返回了输入文件本身 | `affected --filter` 短路 | P5 |
| 结果体积暴涨 | `files` 无 `--max-depth` / `--format flat\|grouped` / `--limit` 无效 | P8 P9 P3 |
| 体积非单调（参数调小反而变大） | `maxFiles` × 多符号 bag 交互 | P7 |
| 参数不生效 | `node` 符号模式忽略选项 / `node --file` 写法 | P10 P11 |
| 参数含义与预期不符 | `-f` 因命令而异 / `path` 形式不统一 / `--limit` per-definition | P2 P12 P3 |
| 版本升级后行为变化 | 全部 | `measurements.md` §3 |

---

## 1. 陷阱清单 P1–P12

### P1 · `--kind` 非法值静默返回空

- **影响参数**：`query --kind`
- **症状**：`query --kind func` 返回空结果，**不报错**，极易误判为"符号不存在"。
- **根因**：`--kind` 有效取值集合固定，**没有 `func` / `function`**；且**任何非法值都静默返回空**（实测 `bogus`/`xyz` 同样无报错）。
- **正确做法**：Java 方法用 `--kind method`；"查不到"时 **MUST** 先核对 kind 拼写，再怀疑符号不存在。
- **有效取值（实测）**：`method`、`class`、`field`、`enum`、`enum_member`、`interface`、`route`、`constant`、`namespace`、`import`、`file`。
- **匹配算法**：子串 + 编辑距离≤2，**大小写不敏感**（完整矩阵见 `measurements.md` §1）。

### P2 · `-f` 短选项含义因命令而异

- **影响参数**：`-f`（跨命令）
- **症状**：把 `callers -f` 的用法套到 `affected` 或 `context` 上，行为完全不符预期。
- **根因**：`-f` 在不同命令下绑定不同长选项：

| 命令 | `-f` 实际含义 |
| :--- | :--- |
| `callers` / `callees` / `impact` / `node` | `--file`（文件收窄） |
| `affected` | `--filter`（glob 过滤） |
| `context` | `--format`（输出格式） |
| `init` / `index` / `uninit` | 运维语义（见 `cli-commands.md` §3） |

- **正确做法**：**跨命令套用前先看 `--help`**。

### P3 · `--limit` 是 per-definition，不减少定义数

- **影响参数**：`callers --limit` / `callees --limit`
- **症状**：设了 `--limit 1` 结果仍然巨大，体积几乎没降。
- **根因**：`--limit` 是**每个定义最多 N 个 caller**，**不是全局总数**，**不减少定义数**。
- **实测证据**：某 getter（如 `getXxxId`）有 483 个同名定义，`--limit 1/3/10/20` 下**定义数恒为 483**，仅每个定义下的 caller 行数变化（749→938→1075→1168）。
- **补充**：`-f` 命中后 `--limit` 仍生效（`-f XxxDto.java --limit 1` 返回 1 个 caller，`--limit 2` 返回 2 个）；`-f` 命中且该定义无 caller 时 `--limit` 完全无影响（输出恒为 262B）。
- **正确做法**：**`-f` 才是控制体积的第一手段**（249KB→262B）；`--limit` 仅微调每个定义的列表长度（249KB→232KB）。

### P4 · `-f` 未命中不报错，反而显示全部定义

- **影响参数**：`callers -f` / `callees -f` / `impact -f` / `node -f`
- **症状**：加了 `-f` 结果反而变多。
- **根因**：`-f` 无匹配时**不报错**，而是显示全部定义并附提示（`no match: show all with a note`）。
- **正确做法**：**看到结果变多要警惕 `-f` 未命中**，先核对文件名/后缀拼写。

### P5 · `affected --filter` 短路陷阱

- **影响参数**：`affected --filter`
- **症状**：返回结果里只有输入的那个 changed file 本身，没有真实测试。
- **根因**：若 glob **同时匹配到 changed file 本身**，工具会**跳过依赖遍历**（`totalDependentsTraversed: 0`）并把 changed file 当作"受影响测试"返回。
- **实测证据**：`--filter "*.java"` 返回 `[<changed-file>]`（即输入文件本身）。
- **正确做法**：**MUST** 用足够具体的 glob（如 `**/*Test.java`、`**/test/**`）避免误匹配 changed file。
- **补充语义**：
  - **`--filter` 是"替换"而非"叠加"**：不传时默认只返回 `src/test/` 下的文件；传了则按 glob 重新筛选**全部依赖方**（可命中 `src/main/` 源码）。实测 `--filter "*Impl*.java"` 返回 17 个（含 main 源码），默认仅 5 个（仅 test）。
  - **glob 匹配全路径**：`*` 不跨 `/`，`**` 跨目录。实测 `domain/Xxx.java` 命中、`zzz/Xxx.java` 不命中。
  - **无匹配时**：返回 `ℹ No test files affected by the changed files.`（不报错）。

### P6 · `affected --depth` 默认 5 漏报

- **影响参数**：`affected --depth`
- **症状**：只找到 5 个测试，实际有 12 个。
- **根因**：与 `impact` 不同，`affected` 的 `--depth` **显著改变结果数量**，默认 5 会漏报。
- **实测证据**（同一源文件）：

| depth | 0 | 1 | 2 | 3 | 4 | 5（默认） | 6 | 7 | 8 | 10+ | 负数 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 测试数 | 0 | 0 | 3 | 4 | 5 | **5** | 6 | 7 | 8 | 12 | 0 |

- **要点**：默认 5 可能漏报（实测 depth 10 才拿到全部 12 个）；**`--depth 0`/`1`/负数均返回 0 个**（不报错，静默空结果）。
- **正确做法**：怀疑漏报时 **MUST** 显式提高 `--depth`（如 `--depth 10`）重跑。

### P7 · `maxFiles` 体积非单调

- **影响参数**：`maxFiles`（MCP）/ `--max-files`（CLI）
- **症状**：把 `maxFiles` 调小，输出反而变大。
- **根因**：`maxFiles` 改变的是**入选文件集合**（非简单截断），不同集合的源码长度不同，因此体积会波动。
- **实测证据**（bag 3）：

| maxFiles | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8+ |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 输出 | 10.4KB | 17.7KB | 20.9KB | 22.5KB | **26.8KB** | 25.4KB | 24.4KB | 24.1KB |

- **正确做法**：**MUST NOT** 假设"maxFiles 越小输出越小"；`maxFiles` 仅作辅助兜底，主力是查询精度 + `-f`。
- **补充**：`maxFiles 1` 特殊——输出不含 `source for N files` 尾部提示，且体积最小（约 10KB）。
- **默认值陷阱**：MCP 工具**声明默认 12，实测默认 8**，硬上限 11（完整对照见 `measurements.md` §2.3）。

### P8 · `files` 无参数输出 437KB

- **影响参数**：`files`
- **症状**：一次 `files` 调用直接撑爆上下文。
- **实测证据**（3,186 文件项目）：

| 写法 | 实测输出 |
| :--- | :--- |
| `files`（默认） | 437KB ❌ |
| `files --max-depth 1` | 152B ✅ |
| `files --max-depth 2` | 274B ✅ |
| `files --max-depth 3` | 355B ✅ |
| `files --no-metadata` | 377KB ❌（仅去元数据，不减条目） |

- **正确做法**：**MUST** 至少加 `--max-depth`；**禁止无参数 `files`**。

### P9 · `--format flat/grouped` 忽略 `--max-depth`

- **影响参数**：`files --format`
- **症状**：加了 `--max-depth` 却完全没收窄。
- **实测证据**：`--format flat --max-depth 1/2/3` 输出**恒为 476KB**（完全未收窄）；`grouped` 同（457KB）。且 `--filter`/`--pattern`/`--no-metadata` 均无法有效收窄（最低仍 416KB）。
- **正确做法**：**MUST 使用默认 `--format tree` + `--max-depth`**；**禁止**在大型项目上使用 `--format flat`/`grouped`。

### P10 · `node` 符号模式忽略 `--symbols-only`/`--offset`/`--limit`

- **影响参数**：`node`（符号模式）
- **症状**：加了 `--symbols-only` 仍返回源码；加了 `--offset/--limit` 仍返回全文。
- **根因**：这些选项**仅文件模式生效**；符号模式忽略它们（实测：加与不加输出逐字节相同）。
- **实测对比**：

| 模式 | 调用形式 | 输出内容 | 实测体积 |
| :--- | :--- | :--- | ---: |
| **符号模式** | `node <符号名>` | 符号定义 + 成员列表 + 调用链 | 1,980 B |
| **文件模式** | `node --file <路径>` | 文件全文（带行号）+ 依赖方 | 978 B |
| 文件模式 + `--symbols-only` | `node --file <路径> --symbols-only` | 仅符号映射 + 依赖方 | 1,157 B |
| 文件模式 + `--offset/--limit` | `node --file <路径> --offset N --limit M` | 指定行区段 | 735 B |

- **补充**：符号模式可用 `--file` 消歧（同名符号多定义时），但输出仍为符号视图。
- **正确做法**：要读文件区段 **MUST** 用文件模式（`node --file`）。

### P11 · `node --file` 写法陷阱

- **影响参数**：`node --file`
- **症状**：`--symbols-only` 不生效仍返回源码；或报 `too many arguments for 'node'`。
- **根因**：文件模式 **MUST** 把路径作为 `--file` 的**值**。把路径当**位置参数**再跟 `--file` 时，`--file` 失去取值，后续选项被忽略或报错。
- **实测证据**：

| 写法 | 实测结果 |
| :--- | :--- |
| `node --file <路径> --symbols-only` | ✅ 输出符号映射（1156B，无源码块） |
| `node --file <路径> --offset 1 --limit 5` | ✅ 输出指定行区段 |
| `node <路径> --file --symbols-only` | ❌ `--symbols-only` **不生效**，仍返回源码（618B） |
| `node <路径> --file --offset 1 --limit 5` | ❌ 报错 `too many arguments for 'node'` |

- **补充**：文件模式 `--offset` 越界不报错，返回提示 `has N lines — offset M is past the end`（实测 543B）；`--offset 0`/`-1` 等同从第 1 行开始；`--limit 0`/`-1` 等同不限行数（返回全文）。

### P12 · `path` 参数形式不统一

- **影响参数**：`path`（跨命令）
- **症状**：`status -p <path>` 报 `unknown option '-p'`。
- **根因**：两类命令的 path 传法不同：

| 命令族 | path 形式 |
| :--- | :--- |
| `explore`/`callers`/`callees`/`impact`/`query`/`node`/`context`/`files`/`affected` | **`-p, --path <path>`** |
| `status`/`init`/`sync`/`index`/`uninit` | **位置参数 `[path]`** |

- **正确做法**：跨命令套用前先看 `--help`。
