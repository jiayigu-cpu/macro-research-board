# 交接说明：让外部 AI 修改这个看板

这份文档是写给「接手改动的 AI」看的。读完它你就能知道：改哪个文件、怎么本地预览、哪些东西绝对不能碰、以及部署边界在哪。

---

## 1. 它是什么

一个**纯静态前端 + 一个零依赖 Node 小服务 + 一个 Python 抓数脚本**组成的宏观研究看板。

- 线上主站：`https://doreenboard.online`（自有服务器，Node + systemd）
- 静态备份站：`https://jiayigu-cpu.github.io/macro-research-board/`（GitHub Pages）
- 数据每天自动抓取（akshare → `data.json`），计算层把原始序列算成结论

**没有框架、没有构建、没有 npm 依赖。** 改完存盘、刷新浏览器就能看到效果。请不要引入 React/Vue/Tailwind/Webpack/Vite 或任何构建步骤。

---

## 2. 只改前端：你需要哪些文件

如果只是改样式、布局、文案、图表呈现——**只需要 `public/` 这一个目录**（620 KB，含一份真实数据快照 `data.json`）。

```
public/
├── index.html      页面骨架（所有区块容器、标题、锚点）
├── styles.css      全部样式（~1200 行，CSS 变量控制主题色）
├── app.js          全部渲染逻辑（~1400 行，IIFE，无模块化）
├── config.js       静态配置：八卦限表、仓位矩阵、阶段地图、行业分组、
│                   政策工具箱、宏观日历、传导链、资产暴露矩阵
├── charts.js       轻量图表基元（自绘 SVG/canvas，不依赖 ECharts）
├── live.js         行情刷新辅助
└── data.json       数据快照（416 KB）——**只读，不要手改**
```

拿到这个目录后，它自己就能跑：前端先请求 `api/dashboard`，失败会自动回退到同目录的 `data.json`。所以放任何静态服务器上都能完整预览。

**本地预览（任选一种）**

```bash
cd public && python3 -m http.server 8080     # 然后开 http://localhost:8080
```

或者用整仓的服务（能同时看到「真实接口 + 抓数按钮」）：

```bash
node server.js --port=7101                   # 零依赖，只需 Node
```

---

## 3. 文件职责表：改哪里影响什么

| 想改什么 | 改哪个文件 | 风险 |
|---|---|---|
| 颜色、间距、字号、卡片样式、响应式断点 | `public/styles.css` | 低 |
| 新增/删除区块、调整区块顺序 | `public/index.html` + `public/app.js` | 中，要同步改两处 |
| 某个模块怎么渲染、显示哪些数字 | `public/app.js` 里对应的 `renderXxx()` | 中 |
| 文案、标签、行业分组、日历排期、政策工具箱条目 | `public/config.js` | 低 |
| 指标怎么算（三轴方向、卦限、库存阶段、仓位、政策强度、六因子、风格、趋势） | `macro_v2.py` | 高，会动摇三张结论卡 |
| 数据从哪来、加新指标 | `fetch_data.py` | 高，要有 akshare 环境 |
| 接口行为、缓存、抓数调度 | `server.js` | 高，改错会让整站 404 |

---

## 4. 绝对不能碰的

1. **`public/data.json` 是抓数产物，不是源码。** 416 KB 的真实数据，不要手改、不要重新格式化、不要"清理"。前端全部依赖它的字段结构。
2. **不要改 `data.json` 的字段名。** 想知道结构看第 6 节。
3. **改完 css/js 必须升 `index.html` 里的版本号**，否则浏览器吃缓存，你会以为"改了没生效"：
   ```html
   <link rel="stylesheet" href="styles.css?v=5.5">   <!-- 改成 5.6 -->
   <script src="app.js?v=5.5"></script>              <!-- 改成 5.6 -->
   ```
4. **不要删 `config.js` 里已有的字段**，只增改。`app.js` 会直接读这些键，缺一个就是 `undefined` 渲染成 `NaN`。
5. **不要引入构建工具或包管理**（见第 1 节）。

---

## 5. 这个项目的三条设计约束

改出来的东西要符合既有风格，否则会显得很突兀：

**① 卡片默认只显示结论，点击才展开细节。**
这是整站的交互铁律，没有例外。卡面上只放：模块名 + 当前值 + 一句话结论。公式、判定规则、底层数值、走势图全部放进点击后弹出的抽屉里（`openDrawer()`）。不要在卡面上堆参数。

**② 颜色语义是中国市场习惯。**
涨/利好/风险告警 = 红（`--up`），跌/利空 /正常 = 绿（`--down`）。**不要用绿色表示"好"**，会对读者造成语义混乱。

**③ 结论必须从同一个计算结果来。**
顶部三张结论卡和各模块显示的数字，必须读同一份 `macro_v2` 结果，不允许各算各的。改计算逻辑时尤其要注意——只算一次，多处引用。

---

## 6. `data.json` 结构速查

```js
{
  updated_at: "2026-11-27 23:37:16",
  errors: [],                        // 抓数失败项，正常应为空数组

  series: {                          // 所有原始时序
    "cpi_yoy": { points: [["2026-10", 0.7], ...], unit: "%", freq: "M", n: 96 }
  },

  dims: {                            // 六维指标体系（正式值 + 高频代理）
    growth: {...}, inflation: {...}, liquidity: {...},
    policy: {...}, external: {...}, credit: {...}
  },

  macro_v2: {                        // 计算层输出，前端主要读这里
    axes:      { growth: {dir, ...}, inflation: {...}, liquidity: {...} },
    octant:    { id, name, months_in, trail },      // 八分象限
    inventory: { stage, months_in },                // 库存周期四阶段
    position:  { label, season, kitchin },          // 仓位建议
    policy:    { index, percentile, parts, series },// 政策强度指数
    factors:   [...],                               // 六因子 z 分数
    style:     { score, label, signals },           // 风格（9 信号）
    trend:     { rows: [{ asset, available, broken, broken_parts }] },
    erp:       { value, pctile },
    industry:  { items: [...], n }                  // 31 个申万一级行业
  },

  manual: {                          // 政策工具箱人工口径
    updated: "2026-11-27",
    items: { "deficit": { v: "4.0% 左右", note, asof, src, auto } }
  }
}
```

取值时注意：`series[key].points` 是 `[日期字符串, 数值]` 的数组，**可能为空**。所有渲染都要处理"数据缺失"——显示「数据更新中」，不要显示 `NaN`、`undefined`、空白或 `--%`。

---

## 7. 部署：能不能直接上线？

**分两条链路，权限完全不同。**

### 链路 A：GitHub Pages（自动化，但只更新备份站）

```
你 push 到 main  →  .github/workflows/deploy-pages.yml  →  发布 public/ 到 Pages
```

这条是自动的，push 完等 1–2 分钟就生效，地址是 `jiayigu-cpu.github.io/macro-research-board`。**注意它只发布 `public/` 目录的静态快照，不含 Node 服务、不含自动抓数。**

### 链路 B：主站 doreenboard.online（手动，需要服务器凭证）

主站是腾讯云服务器上的 systemd 服务，**外部 AI 拿不到、也不该拿到**。部署动作是：

```bash
# 纯前端改动（只覆盖静态文件，不用重启服务）
scp public/{index.html,styles.css,app.js,config.js} ubuntu@<服务器>:/opt/macro-board/public/

# 改了 server.js 才需要重启
ssh ubuntu@<服务器> "sudo systemctl restart macro-board"
```

服务器地址、SSH 密钥不在这个仓库里，也不应该发给任何外部 AI。

### 所以，现实的做法

外部 AI **只负责改 `public/` 里的文件并把改好的文件给你**，不要指望它部署。你自己（或用你惯用的助手）执行上传 + 校验，出事能立刻回滚。

如果要让它自己验证效果，给它 `public/` 目录 + 一句「用 python3 -m http.server 起静态服务，打开 8080 端口截图确认」，它就能看到真实渲染结果——不需要服务器。

---

## 8. 让它交付时的话术模板

把这些要求一起发给它，能省掉大部分返工：

> 这是 `public/` 目录（含真实数据快照 `data.json`，只读，不要修改它）。
>
> 请改 <你的需求>。约束：
> 1. 纯静态，不要引入框架或构建工具；
> 2. 卡面只放结论，细节放点击后的抽屉；
> 3. 颜色遵循 A 股习惯（红=涨/利好，绿=跌/利空）；
> 4. 数据缺失要显示「数据更新中」，不能出现 NaN 或空白；
> 5. 改完把 `index.html` 里的 `?v=` 版本号加一，否则缓存不刷新；
> 6. 用 `python3 -m http.server 8080` 跑起来，截图确认改完的效果再交给我；
> 7. 交付时说明改了哪几个文件、每个文件改了什么。
