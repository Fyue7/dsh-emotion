# dsh-emotion

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent **输出文本自带情绪**：语气、节奏、共情方式随「情境 + 持续情绪状态」变化，且不牺牲技术准确性、不显著增加成本与延迟。

> 非官方社区插件，与 DeepSeek 官方无隶属或背书关系。

## 它做什么

| 能力 | 说明 |
|---|---|
| **持续情绪状态** | 会话投影里的 `emotion` 单元：心情 / 能量 / 轮数 / 连续成败。随工具调用结果、模型重试、轮次收尾变化，跨轮累积，**宿主负责持久化** |
| **两段注入** | `emotion:rules`（system prompt section，order 2，静态规则）+ `emotion:state`（runtime-context，order 130，动态状态）。动态段走宿主请求**末尾**的 runtime-context 快照，前面的历史照常命中原有前缀缓存 |
| **会话头部情绪条** | emoji + 基调词 + 心情条；hover 看成因、能量、轮数。走宿主已有的会话投影通道，**不新增任何 HTTP 路由** |
| **`/mood` 命令族** | 配置入口，含 `/mood why` —— 直接打印实际注入给模型的提示词 |
| **风格档案** | 可选的人格/文风层。探测 `$DSH_HOME/dsh-emotion/style-profile.json`，缺失时用随包的格式示例，再缺失则只注入情绪规则（优雅降级） |

### 分工：谁负责判断什么

| 层 | 由谁负责 | 为什么 |
|---|---|---|
| **用户此刻的情绪** | **主模型**，在其思维链里完成 | 免费（推理模型本来就在思考）、能读懂言外之意、每轮即时 |
| **持续状态** | **本地规则**（纯函数） | 跨轮累积量模型看不到；可复现、可单测、零成本 |

本地规则**只**消费可观测事件，不解析对话内容 —— 不重复造一个更差的意图识别器。

## 约束分两层

### 不可协商（无开关）

- **信息不许缩水**：该报的数字、结论、报错、风险一条不少。技术完整性压过任何行数预算。
- 不复述原著情节、不出现角色名、不输出暴力/伤亡/宗教/自毁/牺牲类表达。
- **不成段复现任何原文**：连续 12 个汉字以上与原文一致的表达一律不得出现。
- 不播报情绪数值。

> 为什么是 12 字：把文本切成 12-gram 后，七万级片段里 99.8% 只出现一次，说明「罕见度」判据几乎恒真，
> **真正的判别量是长度**；12 字刚好放过「我靠」这类通用表达。
> 这一条是被实测验证过的 —— 一个只在 60 条里抽查的校验会漏掉 1% 级的系统性错误。

### 可切换：技术内容要不要保持朴素

这一层只管**讲法**，不管信息量。

| 模式 | 技术内容怎么讲 |
|---|---|
| `plain` | 代码、命令、路径、报错、参数、数字一律朴素准确，不比喻、不拟人、不抒情。情绪只落在过渡句与收尾上 —— 这是 v0.1.x 的行为 |
| `loose`（**默认**） | 数字、路径、报错原文仍然逐字不许改，但怎么讲由模型定：可以比喻，可以带着口气讲一段技术过程 |

```
/mood plain=on     # 回到朴素模式
/mood plain=off    # 放开讲法
```

或写进 profile 配置：

```yaml
- id: emotion
  name: dsh-emotion
  config:
    plainTechnical: false
```

为什么默认 `loose`：`plain` 那条一旦摆在规则里，模型会把「技术内容保持朴素」读成「只要这轮在谈技术就整段肃静」，
于是所有回复都长成说明书 —— 这是实测出来的，不是推测。而 `loose` 只放开讲法，信息量另有条款锁着，两者不冲突。

> 需要宿主 `@deepseek-ai/dsh-system-prompt` 提供 `systemPrompt.context()`（runtime-context 注册面，0.2.0-rc 起）。

## 安装

### 从 GitHub（无需构建）

```powershell
dsh plugin --profile <name> add github:<you>/dsh-emotion
```

本插件是**纯 ESM JavaScript，没有构建步骤**，因此不需要 `prepare` 脚本，
用户也不需要在 `pnpm-workspace.yaml` 里授权 `allowBuilds` —— 那一道坎只对需要编译的包存在。

### 从 npm

```powershell
dsh plugin --profile <name> add dsh-emotion
```

### 本地开发（可热改）

```powershell
dsh plugin --profile <name> add ./path/to/dsh-emotion
```

`dsh plugin add <本地路径>` 走 `link:`（软链），改完源码**重启即可生效**。

若用 `file:` 显式安装则是**复制**，改动**不会自动生效** —— 而且实测有两个陷阱：

| 你以为 | 实际 |
|---|---|
| 改完源码，跑一遍 `pnpm install` | **不会**更新副本（`pnpm` 认为依赖没变） |
| 那就升个版本号，再 `pnpm install` | **还是不会**（版本号变了也不触发重解析） |
| — | 只有 **`pnpm remove` + `pnpm add`**，或直接用 `link:`，才会拿到新代码 |

> 更糟的是失败是静默的：旧副本继续跑旧代码，你只会觉得「改了怎么没效果」。
> 所以开发期推荐 `link:`。

`file:` 安装下确实要改副本时，仓库自带一个同步工具（对比 + 拷贝，不做别的）：

```powershell
node tools/sync.mjs           # 同步 lib/ client/ style/ package.json
node tools/sync.mjs --check   # 只比对，有差异则以退出码 1 结束（CI 用）
```

它解决的是同一个坑的另一半：在 `E:\...\dsh-emotion` 改完源码，`~/.dsh/profiles/<name>/node_modules/dsh-emotion`
里那份**不会跟着变** —— 两边文件其实长得一模一样，只是各是各的。同步完仍需**完全重启** Harness，模块缓存不会自己刷新。

安装后重启 DSH。验证层已生效（不启动）：

```powershell
dsh --profile <name> --dump-config
```

## 配置

写在 profile 的 `cordis.patch.yml`（`.volatile()` 字段才会持久化）：

```yaml
- id: emotion
  name: dsh-emotion
  config:
    enabled: true
    intensity: mid          # low | mid | high
    styleBias: balanced     # restrained | balanced | outgoing
    styleProfile: auto      # auto | off
    plainTechnical: false   # true = 技术内容保持朴素（v0.1.x 行为）
```

`enabled: false` 时两个段都不注入，行为与官方一致。

## 命令

| 命令 | 作用 |
|---|---|
| `/mood` | 状态、生效配置、风格档案来源、schema 校验模式 |
| `/mood on` / `off` | 运行时开关（覆盖配置，重启后回到配置值） |
| `/mood why` | **打印实际注入的两段原文** —— 排查「它今天怎么这么冷淡」的第一现场 |
| `/mood reset` | 清除本会话的手动调整量 |
| `/mood intensity=high style=outgoing profile=off` | 改运行时配置 |
| `/mood plain=on` / `plain=off` | 技术内容切回朴素 / 放开讲法 |
| `/mood mood=20 energy=80` | 设本会话**调整量**（投影状态本身不可写，见下） |

## 风格档案

档案是可选的。没有它，插件仍然工作 —— 只是少了文风层。

```jsonc
{
  "source": "你的文本",
  "rhythm": { "avgSentenceLen": 28.2, "shortSentenceRatio": 0.233, "longSentenceRatio": 0.251 },
  "punctuation": { "dash": "rare", "ellipsis": "occasional" },
  "styleDirectives": ["不直说情绪，用动作侧写", "收尾留一句轻的"],
  "lexicon": { "joy": [], "sad": [], "tired": [] },
  "imagery": ["用天气写心情"],
  "verbalTics": [],
  "addressForms": { "user": "你", "self": "我" },
  "samples": []
}
```

字段含义见 `style/style-profile.example.json`。

### 生成你自己的风格档案

仓库自带一套流水线（零依赖，完整说明见 [`tools/README.md`](tools/README.md)）：

```powershell
# 机算轨：全文的量
node tools/distill.mjs stats --corpus .\我的文本 --out stats.json

# 人读轨：合并分片精读的产出，过两道校验门
node tools/distill.mjs merge --digests .\digests --corpus .\我的文本 --stats stats.json --out style-profile.json

# 输出侧护栏：检查一段文本有没有成段复现原文
node tools/verdict.mjs --corpus .\我的文本 --text "要检查的文本"
```

两轨的分工：**机算轨**产出 `rhythm` / `punctuation`，是可复现的事实；
**人读轨**产出情绪样本、句式模板与声线，需要真的读一遍。

两道**必须**的校验门：

- **保真门**：每条引文回原文逐字比对。关键是要区分「编造」与「位置标错」——
  先查声称位置，查不到再全库搜寻真实归属，**全库都没有才判编造**。
  一律丢弃会损失真实素材（实测 7 条存疑引用里有 3 条只是标错了一章）。
- **反误杀门**：安全过滤若用单字符正则，会把 `决定性一击`（命中「性」）这类正常文本杀掉。
  硬拦截只用**多字无歧义词**，单字只作降级标记；且**模板的生死只看模板本身，不看示例**。

> ⚠️ 只抽查几十条发现不了保真问题 —— 1% 的错误率意味着抽查 60 条大概率一条都碰不到。

写完档案放到 `$DSH_HOME/dsh-emotion/style-profile.json`（用户级，优先）
或 `style/style-profile.json`（仓库内，已被 `.gitignore` 排除）。

> ⚠️ 若你的语料是受版权保护的作品，**不要把生成的档案提交到公开仓库**。
> 本项目的 `.gitignore` 已默认排除它。

## 架构

```
lib/state.js       纯函数状态机（无 IO、无时间依赖 → 可完整单测）
lib/prompt.js      提示词编译（纯函数；含 {{…}} 消毒）
lib/style.js       风格档案加载与渲染
lib/schema.js      zod 容错层（zod 不可用时降级为浅校验，保证插件仍能加载）
lib/store.js       跨会话亲密度持久化（原子写 + 节流 + 损坏回落）
lib/index.js       Host 半：投影 + 两个段 + /mood
client/index.js    客户端半：会话头部情绪条（裸 ESM，无构建）

tools/distill.mjs  蒸馏流水线：stats（机算轨）+ merge（人读轨，含两道校验门）
tools/verdict.mjs  输出侧护栏：检查文本有没有成段复现原文
```

## 测试

```powershell
node test/run.mjs         # 17 项：状态机与提示词的纯函数纪律
node test/smoke.mjs       # 23 项：桩件模拟宿主，验证注册形状与命令族
node tools/test/run.mjs   # 14 项：流水线，含两条教训的回归测试
```

`smoke.mjs` 用 ESM 解析钩子把宿主包映射到 `test/stubs/`，
因此**源码保持原样**，不需要为了测试塞假的 `node_modules`。

关键断言：无关事件返回同一引用（破了注册表的 `Object.is` 闸门就失效）、
`apply`/`view` 同步（异步会被 `viewSchema.parse` 拒绝）、边界 clamp、
`{{…}}` 消毒（一处残留就能让整个提示词组装抛错、会话不可用）、配置三种形态容错。

## 踩坑记录

实现过程中发现的几个真实问题，都在代码里留了注释：

| # | 问题 | 修正 |
|---|---|---|
| 1 | `tool/result` 的失败标志在 `event.data.message.isError`，不在 `event.data.isError` | 判据改为 `message.isError === true \|\| error != null`。**照抄二手文档的话失败分支永远不触发** |
| 2 | 会话投影**没有写入 API**，`stateOf` 还明确禁止改返回值 | `/mood set` 改为「本会话调整量」，在编译期叠加 |
| 3 | 跨会话的 `closeness` 在**逐会话**投影里装不下 | 保留一处 `session/event` 监听，仅用于推进亲密度 |
| 4 | 段文本默认做变量插值，未知 `{{…}}` 会让组装抛错 | 所有进入段文本的外部内容过 `sanitizeBraces`，并有单测 |
| 5 | `pnpm` 的 `file:` 是**复制**不是软链，且改完源码 `pnpm install` **不会**更新副本（升版本号也不行） | 开发用 `link:`；`file:` 必须 `remove` + `add` |
| 6 | **投影里做不了时间衰减**，但**也不能不做回归** —— 实测连续 50 次工具成功就把心情顶到 +100 并锁死，状态段此后每轮输出同一句话，等于没注入 | 把「回归基线」挂在 `turn/end`（每轮必然发生）上：`mood ×= 0.5`。仍是同步纯函数，不引入定时器 |

## 相关项目

社区里还有几个方向相近的插件，差别在于侧重：

- [`jonah791/dsh-agent-emotion`](https://github.com/jonah791/dsh-agent-emotion) —— 六维人格棱镜，侧重结构化事件信号与人格权重漂移
- [`wobenshiwomu/dsh-calm`](https://github.com/wobenshiwomu/dsh-calm) —— 情绪检查点与上下文修复

本插件的侧重是：**可蒸馏的文风层** + **宿主持久的会话状态** + **可验证的输出护栏**。

## 许可

MIT（仅覆盖源代码）。详见 [LICENSE](LICENSE) 末尾的内容声明。
