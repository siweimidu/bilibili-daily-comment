---
name: bilibili-daily-comment
description: 抓取指定 B 站 UP 主「当天全部视频」的置顶评论，抽出其中的 AI 资讯条目，按热度排序、去掉重复与旧闻，输出一行一条的纯净资讯清单（不带账号名 / 不带热度数字 / 不带 BV 号）。用户说「抓今天的置顶评论」「AI日报的置顶评论」「这几个UP今天置顶说了什么」「置顶评论热度榜」「每日B站评论」时使用；也支持指定日期、增删监控账号、重新扫码登录、手动跑一次。
---

# B站当天置顶评论 → AI 资讯清单

抓一组 UP 主「当天发布的所有视频」的**置顶评论**，把里面的 AI 资讯拆出来，去重、去旧闻、去噪音，按热度排序，输出一行一条的纯资讯。

## 标准用法（一句话跑完）

~~~powershell
& "C:/Users/35238/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" "C:/Code/skills/bilibili-daily-comment/scripts/daily.mjs"
~~~

- 默认抓**北京时间当天**；指定日期加 `--date 2026-10-28`
- 打印到 stdout，同时写 `out/<日期>/report.md` 和 `out/latest.md`
- 用户要的就是这份清单：**原样贴出去**，不要加分栏、不要补账号名、不要补热度

## 输出长什么样

~~~text
2026-10-29 置顶评论 · 共 36 条

1. OpenAI 向 ChatGPT Pro 和 Business 订阅用户发放 API 额度
2. MiniMax Code 团队开源 MCode Stack，公开日常 Agent 工作流
3. Google 推出 Gemini 4 Carbon，先向部分用户开放
~~~

**行内只有资讯正文**：不带账号名、不带 `（热度 …）`、不带 BV 号、不带时间戳。要改的话看 config 的 `showSource`。

## 过滤链（顺序有意义，别乱调）

一条置顶先被时间戳切成一条条候选，然后逐个过闸：

1. `chapterPatterns` — 章节标题（输出示例/价格/跑分/开场…）直接扔
2. 含 `http` / `b23.tv` / `BV…` 的导流行扔掉
3. `offTopicPatterns` — 硬件与财务（MacBook/iPhone/眼镜/财报/营收/股价…）不算 AI 新闻，扔
4. `aiKeywords` — 必须命中 AI 相关实体或技术词（整词匹配，`Gmail` 里的 ai 不算）
5. `actionKeywords` — 必须有动作（发布/推出/开源/收购/起诉/更新…），否则是名词短语不是新闻
6. `minItemLength` — 太短的扔
7. **`pinNewsRatio`** — 整条置顶里通过上面各闸的比例低于 0.6，说明这条置顶只是视频章节目录或闲聊盘点，**整条丢弃**（这是挡掉「价格 & 开放时间」「输出示例 1/2/3」以及混合盘点视频里旧闻的关键）
8. 去重合并（见下）
9. `dropSeenHistory` — 前几日已经报过的条目不再重复出现，历史存在 `out/_history.json`

## 章节型置顶 → 用视频标题兜底

单条新闻视频的置顶常常是**章节目录**（`00:04 Google 发布… / 00:10 价格 & 开放时间 / 00:14 输出示例 1…`），拆出来全是噪音。但这类视频的**标题本身就是新闻标题**，而且它的置顶往往点赞最高。

所以：通过率 < `titleFallbackRatio`（0.3）或整条没一条能用时，**改用视频标题当资讯候选**（剥掉开头的【突发】【黑鸦】这类标签），热度仍沿用置顶点赞。

这条规则是必须的：少了它，`BV1yCsR6ZE9V`（119 赞的章节型置顶）一被丢，当天最大的新闻 `Google 发布 Gemini 4 Carbon` 就失去了最高热度来源，从第 1 掉到第 3，看起来像「这条新闻消失了」。

## 置顶评论怎么判定（踩过的坑，别改回去）

`reply/main?type=1&oid=<aid>&mode=3` 返回里：

- **登录态**：置顶在 `data.upper.top`
- **匿名态**：`upper.top` 是空的，置顶其实是 **UP 主本人那条评论，落在 `data.top_replies`**

判定顺序：`upper.top` → `top_replies` 里 `mid` 等于该 UP 的那条 → 都没有才算无置顶。
只认 `upper.top` 会让匿名抓取时**全部**被判成无置顶（踩过一次）。

## 判重规则

两条候选只要满足其一就合并：

- 字符二元组 Jaccard ≥ `dedupeThreshold`（0.55）
- **实体集合**：双方各 ≥2 个实体，共享 ≥2 个，其中**至少一个不是泛词**，且包含度 ≥ `tokenContainment`（0.7）

实体集合 = 正文里的拉丁词与数字（`Gemini` / `4` / `Carbon` / `Copilot` / `Fusion`）。**单个数字也要留**——`Gemini 4` 和 `Gemini 3` 靠的就是这个 `4`。

`genericTokens` 是泛词表（openai / chatgpt / gemini / google / anthropic / claude / github / copilot / api / agent / pro / max…）。
规则要求「至少一个非泛词」是为了防误合并：只共享 `OpenAI` + `ChatGPT` 的两条其实是不同新闻，早期版本会把它们并成一条并把热度累加成假的第一名。

合并后正文取**最接近 `headlineTargetLength`（28 字）**的那条，不是最长的那条——太长是视频标题，太短丢信息。热度相加，所以被多个 UP 收录的新闻天然排前面。

## 排序

- `sortMode: "heat"`（默认）：按热度降序，热度 = 置顶评论点赞数，跨源合并时累加
- `sortMode: "importance"`：先按跨源数、再按热度
- `decluster: true`：同一视频的条目不相邻，把撞车的往后挪，避免整段榜单来自同一条早报

## 登录（可选，但强烈建议）

匿名请求风控很凶（-412 / -352 时好时坏），登录态最稳。

1. `node scripts/login.mjs` — 生成二维码到 `.cookie/qr.png`，用 read_image 发给用户扫
2. `node scripts/login.mjs --keep 600` — **推荐**：每 150 秒自动换新码并继续等 10 分钟
3. 手机必须点「确认登录」，否则接口一直返回 `86101 未扫码`；状态写进 `.cookie/poll.log`
4. 成功后写 `.cookie/cookies.json`，SESSDATA 有效期约数月

## 配置一览

| 键 | 含义 | 默认 |
|---|---|---|
| scanCount | 每个 UP 先拉最新多少条视频再按日期过滤 | 30 |
| splitTimeline | 按时间戳把置顶拆成多条 | true |
| pinNewsRatio | 整条置顶的资讯占比门槛，低于它整条丢弃 | 0.6 |
| minItemLength | 单条最短字数 | 10 |
| sortMode | heat / importance | heat |
| decluster | 同源不相邻 | true |
| showSource | 行尾是否带 BV 号 | false |
| maxLines | 只输出前 N 条，0 = 全部 | 0 |
| maxTextLength | 单条截断长度 | 120 |
| titleFallbackRatio | 置顶通过率低于它就用视频标题兜底 | 0.3 |
| headlineTargetLength | 合并后选正文的目标长度 | 28 |
| genericTokens | 判重时不算「独特」的泛词表 | openai/chatgpt/gemini… |
| dropSeenHistory | 跨天去旧闻 | true |
| requestGapMs | 请求间隔（防风控） | 1200 |
| dedupeThreshold / tokenContainment | 判重阈值 | 0.55 / 0.75 |
| chapterPatterns / offTopicPatterns / aiKeywords / actionKeywords / junkPatterns | 各道闸的词表 | 见 config.json |

`ups.json` 是 `[{ "name": "内部备注", "mid": "数字UID" }]`，name 只进日志不进输出。

短链转 mid：

~~~powershell
(Invoke-WebRequest "https://b23.tv/xxxxx" -MaximumRedirection 5).BaseResponse.ResponseUri.AbsoluteUri
~~~

## 定时任务

每晚 19:00 自动跑，Windows 计划任务 `BilibiliDailyComment`（装机脚本 `install-task.ps1`）：

~~~powershell
schtasks /Query /TN "BilibiliDailyComment"
schtasks /Run   /TN "BilibiliDailyComment"
~~~

删除：`schtasks /Delete /TN "BilibiliDailyComment" /F`

## 目录

~~~text
C:/Code/skills/bilibili-daily-comment/   （软链到 ~/.agents/skills/）
  SKILL.md  config.json  ups.json  install-task.ps1  package.json
  scripts/  lib.mjs  login.mjs  collect.mjs  render.mjs  daily.mjs
  .cookie/  cookies.json  qr.png  poll.log
  out/<日期>/  raw.json  report.md    out/latest.md  out/_history.json
~~~

## 故障排查

- **risk control -412 / -352**：确认 `.cookie/cookies.json` 有 SESSDATA；没有先跑登录。仍频繁就把 requestGapMs 调到 2000
- **某账号当天 0 条**：正常，当天没投视频；列表为空且 code≠0 才看 stats.errors
- **清单空了**：看 report 末行统计的丢弃明细，通常是 aiKeywords 或 actionKeywords 太严
- **某条该出现却没出现**：`pinNewsRatio` 可能把整条置顶判成章节/闲聊了，用 `debugPins: true` 打印每条置顶的通过率
- **改了 lib.mjs 的置顶判定要重跑 collect**：判定发生在抓取阶段，只重跑 render 不生效

## 已报道基准账号（去重）

可以把某个账号设为「已报道」基准：把他发过的视频下的置顶/热评时间轴清单（含被拆成两段的长评论）收集成库，日报里凡是与他重复的条目会被去掉，只留没被他报道过的。

- 基准账号配置：seen.json = [{ name, mid, scanVideos }]（默认求源索解）
- 开关：config.json 的 dedupeAgainstSeen: true\n- 建库：ode scripts/build-seen.mjs → 写 out/_seen.json\n- daily.mjs 已按 build-seen → collect → render 顺序自动执行
- 全量模式：ode scripts/daily.mjs --full（今天没发的账号用其最新一条兜底）


## 硬约束（务必遵守）

- **只要当天**：只统计「今天」发布的视频内容，**昨天（及更早）的信息一概不要**。
- 禁止使用 `--full` 兜底（该模式会把账号最新一条=昨天的内容混进来），默认 `node scripts/daily.mjs` 即当天。
- 代码层强制：`config.json` 的 `todayOnly: true`，render 会丢弃 `videoDate != 当天` 的所有条目。
- 只有「已报道基准库」可以用历史视频（那是用来去重的，不进入日报）。


## 去重规范（重要）

- **跨账号同事件合并**：不同账号报道同一件事（如 Gemini Decision、Tabletop、文心=ERNIE 等），合并成一条，保留信息最全的一条。
- **已报道基准 = 你的账号**：以「你的账号」发过的视频置顶/热评时间轴清单为基准，日报里凡是该账号**已经报道过的事件**一律去掉。
  - 基准账号在 `seen.json` 指定（当前为 求源索解，mid=3546968106207327）；换成你本人的账号只需改这里的 `mid`。
  - 先 `node scripts/build-seen.mjs` 建库，再渲染时自动去重。
- 顺序：跨账号同事件合并 → 再去「已报道」→ 当天限制（todayOnly）。


### 已报道基准窗口（更新 · 重要）

- **基准账号 = 你的账号**（在 `seen.json` 指定；当前为 求源索解，改 `mid` 即可换成你本人主页）。
- **窗口 = 最近 4 天**（`seen.json` 的 `days: 4` / `config.json` 的 `seenDays: 4`）。
- 这 4 天内该账号**所有视频**的置顶评论、以及被拆成**两段的时间轴长评论**，全部纳入「已报道库」，用来从日报里去重。
- 建库：`node scripts/build-seen.mjs`（自动按近 4 天过滤，并同时抓置顶区+热评区的 UP 主长评论，含两段拆分）。


## 输出格式规范（最终 · 最重要）

1. **按公司归并**：同一家公司的多条信息合并成**一条**，条目之间用「；」分隔（如「Google：…；…；…」）。
2. **按重要性排序**：公司优先级见 `config.json` 的 `companyOrder`（NVIDIA > OpenAI > Anthropic > Google > 字节跳动 > 百度 > 阿里 > DeepSeek > 智谱 > xAI > Runway > DeepMind > 上海创智学院 > 小红书 > DeepL > 腾讯 > Carbon > Command Code ……）。
3. **带序号**：每条前面加「1. 2. 3. …」。
4. **每次输出用可复制的代码块**（```text … ```）。
5. 公司识别规则见 `config.json` 的 `companyRules`；识别不到的零散条目，保留原文单列在最后。

> 渲染会自动写出 `out/latest.md`（纯文本）与 `out/latest_block.txt`（含 ```text 围栏，可直接复制）。
