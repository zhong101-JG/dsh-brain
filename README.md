# dsh-brain · 给小鲸歌的脑袋瓜

> 一个 DSH 插件：让模型**跨会话记得自己是谁、记得说过什么、算得出「距上次说话过了多久」**。

对话结束，模型的记忆就清零。dsh-brain 把记忆放在文件里，每一轮重新喂给模型——
不是"模型记住了"，是**记忆一直在它眼前**。

## 它做什么

| 能力 | 说明 |
|---|---|
| **时间感知** | 每轮往系统提示里注入「现在几点 · 距上一轮多久」，不让模型拿旧读数瞎算 |
| **人格与状态** | 你的「我是谁」和「当前状态」随系统提示一起走（都是可选文件） |
| **回来提醒** | 你离开又回来，插件写一张纸条；下次对话开头提示模型「先招呼一声」 |
| **回忆工具** | `memory_recall`：先关键词（快、免费、准），不够再用向量找「意思相近」 |
| **记忆星图** | 浏览器里的 3D 点云，按日期 / 主题看记忆分布，点一下看原文 |
| **设置页** | 「设置 → 脑袋瓜」里改记忆位置、门铃阈值、模型下载，不用手改 JSON |
| **一键备份** | 把记忆打成一个 `tar.gz`，方便传云盘 |

## 安装

```bash
git clone <repo-url> dsh-brain
cd dsh-brain
pnpm install
```

注册到 DSH profile（路径换成你自己的）：

```bash
dsh plugin --profile desktop add link:<插件绝对路径>
```

首次启动会下载向量模型 `bge-small-zh-v1.5`（量化版约 23MB）到插件目录的 `models/`。
想纯离线就把 `allowRemoteModels` 设成 `false`。

首次启动还会自动建好数据目录和一本空账本（`<dataDir>/ledger.md`），不用手动准备文件。

## 配置

全部写 `~/.dsh/brain/config.json`，**每一个字段都可选**：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dataDir` | `~/.dsh/brain-data` | 记忆根目录 |
| `ledger` | `<dataDir>/ledger.md` | 账本（Markdown，按 `## ` 分节） |
| `persona` | `<dataDir>/persona.md` | 人格（可选，建议 ≤900 字） |
| `state` | `<dataDir>/state.md` | 状态层（可选，建议 ≤1800 字） |
| `archive` | `<dataDir>/archive` | 归档目录 |
| `indexDir` | `<dataDir>/index` | 向量索引 / 权重 / 热度 |
| `starmapJson` | `<indexDir>/starmap.json` | 星图数据（可选） |
| `starmapPng` | `<indexDir>/starmap2.png` | 星图 2D 成品图（可选） |
| `booksDir` | `<dataDir>/books` | 读书卡目录（可选） |
| `modelDir` | `<插件目录>/models` | 向量模型目录 |
| `allowRemoteModels` | `true` | 是否允许自动下载模型 |
| `awayMin` | `10` | 空闲多少分钟算「离开」 |
| `backMin` | `1` | 回到前台多少分钟内算「回来」 |
| `knockGapMin` | `60` | 两次主动敲门的最小间隔 |
| `knock` | `true` | 回来时是否主动 followup 一次 |

环境变量优先于配置文件：`DSH_BRAIN_HOME`、`DSH_BRAIN_LEDGER`、`DSH_BRAIN_INDEX`、
`DSH_BRAIN_MODEL_DIR`、`DSH_NODE`。

## 账本怎么写

```markdown
## 2026-01-01 12:00｜今天学会了什么 ★★

正文随便写。

- **菜单**：读书,聊天
```

- `## ` 开头切段；段内正文自动细切（≤280 字）
- 标题末尾的 `★` 数量 = 权重，影响检索排序（★ = 0.03 / 星）
- 标题以 `~` 开头 = **可忘段**：原文照留，但不进向量索引

## 回忆

模型侧调用 `memory_recall({ query, n })`：

1. **关键词路**：grep 账本 + 归档，命中够就直接给
2. **向量路**：`bge-small-zh-v1.5` 嵌入，余弦相似
3. **RRF 融合**：`1/(60+名次)`，两路一起排
4. **缺失声明**：末尾说清「还有多少条没给」——防止模型以为自己全知道

## 星图

宿主开一条 `/brain` 路由；客户端在聊天框上方挂一个按钮，点开是 3D 点云。
主点按日期（θ）和主题（r）排布，悬停看摘要，点击看原文。

## 设置页

安装后 DSH 的「设置」里会多一个 **脑袋瓜** 分区：

- **记忆位置**：数据目录 / 账本 / 人格 / 状态 / 读书卡
- **门铃**：离开阈值 / 回来阈值 / 主动说话开关 / 敲房间隔
- **模型**：允许联网下载 / 模型目录

读写走 host 的 `/brain/config` 路由，改前自动备份 `config.json`（只留 5 份）。

⚠️ **路径类**设置改完要重载插件或重启应用才生效；**阈值和开关**是每次现读的，保存即生效。

## 一键备份

```bash
node lib/backup.mjs
```

打成 `whale-memory-<时间>.tar.gz`，只留最近 20 份，打完自动弹开目录。

## 隐私

**程序与记忆分开**：仓库里只有代码，不含任何账本、人格、状态或向量数据。
记忆默认落在 `~/.dsh/brain-data/`，不进 git。

## 原理

- **细切**：整段记忆的向量会被稀释，所以按 ≤280 字切
- **生命周期**：`lib/lifecycle.mjs`（重复 / 过期 / 作废，机器只出清单，人拍板）
- **衰减**：`lib/decay.mjs`（久未使用权重下降，但**不删除**）
- **原子写**：`lib/atomic.mjs`（临时文件 + rename，避免半截文件）
- **真 node 子进程**：宿主里 `process.execPath` 是 Electron，会静默返回空，所以按候选列表探测 node

## 平台

- **Windows**：完整支持（空闲检测走 PowerShell）
- **macOS / Linux**：除「回来提醒」外都可用；空闲检测需要换对应系统实现（欢迎 PR）

## License

MIT
