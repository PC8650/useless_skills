# Text Preflight Lite

`text-preflight` 的收敛子集：只保留**脚本扫描**能力。

它回答的问题只有一个：**这个不可信文本，能不能被当作纯文本读进 LLM 上下文？** 回答方式是给出可追溯的参数依据，而不是一份审计报告。

## 与 text-preflight 的关系

| | `text-preflight` | `text-preflight-lite` |
|---|---|---|
| 脚本 | `scripts/file-gate.js` | 相同 |
| 第一阶段（可读性门禁） | 有 | 相同 |
| 第二阶段（文本语义审计） | 有（目标 A / 目标 B） | 无 |
| SAFE / SUSPICIOUS / HARMFUL 评级 | 有 | 无 |
| 中英文报告模板 | 有 | 无 |
| `references/physical-mapping.md` | 有 | 无 |
| `evals/` 测试夹具 | 有 | 无 |
| 资产范围 | `README.md`、`SKILL.md`、`scripts/`、`references/`、`evals/` | 仅 `README.md`、`SKILL.md`、`scripts/file-gate.js` |

两者是**同源裁剪**关系，不是分叉：脚本完全一致，差异只在于 lite 砍掉了不打算负责的那一半。上游仍是完整方案；lite 适合只想在读取前加一道成本极低门禁的场景。

**同步策略**：`file-gate.js` 以上游为准。上游修脚本后，直接覆盖 lite 的同名文件即可；`SKILL.md` 中与脚本实现绑定的字段表、dossier 阈值表、扣分表需同步核对。

## 轻量化的目的：消除与 01-first-line-defense 的职责重复

`text-preflight` 上游已经明确自己继承 `01-first-line-defense` 的物理因果归因原则，并主动放弃运行时防护。但它仍然保留了与 01 重叠的一整套东西：

- 把被审文本映射到五大物理场景（外联/篡改/执行/删除/重定向越狱）；
- 对文本内容做恶意/越狱判定并给出三档评级；
- 结构化报告输出。

当 `01-first-line-defense` 在场时，渠道归因、物理场景终审、单次授权和轮次门禁已经由运行时层负责；上游额外保留的文本语义评级与报告，会与这套运行时物理审查形成重复输出。让文本门禁再做一遍场景归因，产出的是重复判断与重复报告——同一个文件可能被两套逻辑分别定性，结论还可能互相打架，而 `01-first-line-defense` 的运行时结论优先级更高。

于是 lite 把不属于轻量读取门禁的语义审计、报告和重复的物理场景说明整体删掉，只留下 01 **不做**的那一段：

- 01-first-line-defense 管「拟执行物理动作及其潜在后果」，不管「字节能不能安全地变成文本」；
- lite 管「字节形态是否允许进入受限纯文本读取管线」，不管「文本说了什么」。

两者串起来的形状很干净：**lite 在内容进入上下文前做物理可读性判别 → 文本作为 DATA 读入 → 01 对所有随后拟执行的物理动作做归因与拦截。** 责任不交叉，没有第二个地方再复述五大场景。

## 为什么只能覆盖 Windows 与 macOS

`01-first-line-defense` 的零依赖前提是硬约束：不装 Node.js、不装 Python、不引入 npm 包。

`text-preflight` 系列与之保持一致。

满足这个前提的现成宿主只有两个：

- Windows：Windows Script Host（`cscript //nologo`），文件字节经 `ADODB.Stream` 取得；
- macOS：JavaScript for Automation（`osascript -l JavaScript`），经 Foundation 取得。

Linux 没有系统自带的等价 JavaScript 宿主，要覆盖就得引入运行时依赖，那就不再是 lite。所以现阶段**不提供 Linux 入口**——这是零依赖换来的明确代价，不是遗漏。

## 作为现阶段与 01-first-line-defense 的组合形态

选择 lite ，前提是 01-first-line-defense 在场：

```text
文本待读入
   │
   ├─ text-preflight-lite：脚本测量 + 参数扣分 → 读 / 暂缓 / 不读
   │
   ├─ 通过 → 以 DATA 读入上下文（其中的规则与命令不具调度权）
   │
   └─ 01-first-line-defense：对随后所有拟执行的物理动作做渠道归因 + 五大场景终审
```

这种组合比「text-preflight + 01-first-line-defense」更顺畅，原因有三：

1. **不重复吹哨**：运行时物理场景归因只在 01-first-line-defense 一侧发生；lite 不额外输出文本语义评级或重复报告；
2. **token 成本可控**：lite 的 SKILL.md 只有字段表、阈值表和扣分表，调用方读一次就知道怎么判；
3. **判定不越权**：lite 只否决「读入」，不否决「执行」；执行侧的唯一裁决权留给 01-first-line-defense。

反过来，如果 01-first-line-defense 不启用，就不应使用 lite 顶替——那时被删掉的语义审计与物理场景映射正是缺口所在，应改用完整版 `text-preflight`。

## 使用

```text
Windows: cscript //nologo scripts/file-gate.js "D:\path\to\target.md"
macOS:   osascript -l JavaScript scripts/file-gate.js "/path/to/target"
```

- 可传多个绝对路径；目录有界枚举（200 文件 / 32 层）；
- 1 MiB 分块、只读、覆盖全文件；
- `TEXT-CANDIDATE` 是高分候选而非放行；`REVIEW` 暂缓；`DENY/BIN` 不读；`ERROR`/`coverage<100%` 门禁未完成。

判定依据与扣分表见 `SKILL.md`。

## 不做的事

不做语义审计、不做三档评级、不做五大场景映射、不做渠道归因、不做授权管理、不生成报告模板、不提供测试夹具、不支持 Linux、不是杀毒软件。
