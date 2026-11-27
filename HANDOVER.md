# 交接说明：让外部 AI 修改这个看板

这份文档写给「接手改动的 AI」看。读完它你会知道：包里有什么、改哪个文件、怎么跑起来验证、哪些东西绝对不能碰、以及部署边界在哪。

---

## 1. 它是什么

宏观研究看板。三层结构：

| 层 | 技术 | 职责 |
|---|---|---|
| 前端 | 纯静态 HTML/CSS/JS | 渲染结论卡、指标、图表、抽屉 |
| 服务 | Node 内置模块，零依赖 | 静态托管 + `/api/dashboard` + 触发抓数 |
| 数据 | Python + akshare | 抓宏观序列 → `data.json` |
| 计算 | `macro_v2.py`，纯标准库 | 原始序列 → 结论（三轴/卦限/仓位/因子/行业） |

**没有框架、没有构建、没有 npm 依赖。** 前端改完存盘、刷新浏览器就能看到。请不要引入 React/Vue/Tailwind/Webpack/Vite 或任何构建步骤——现有部署链路是直接 `scp` 静态文件，一引构建就断了。

---

## 2. 包里有什么

```
宏观研究看板/
├── public/                  ← 前端全部代码（日常改动 90% 在这里）
│   ├── index.html             页面骨架、区块容器、锚点
│   ├── styles.css             全部样式（CSS 变量控主题，含暗/亮双主题）
│   ├── app.js                 全部渲染逻辑（IIFE，无模块化）
│   ├── config.js              静态配置：八卦限表、仓位矩阵、阶段地图、
│   │                          行业分组、政策工具箱、宏观日历、传导链、资产暴露
│   ├── charts.js              轻量图表基元（自绘，不依赖 ECharts）
│   ├── live.js                行情刷新辅助
│   └── data.json              数据快照（真实数据，**只读**）
│
├── server.js               Node 服务：静态托管 + API + 抓数调度（零依赖）
├── fetch_data.py           抓数脚本（akshare，约 1500 行）
├── macro_v2.py             计算层（纯标准库，可独立运行）
├── manual.json             政策工具箱人工口径（9 项，定时任务维护）
├── data.json               抓数主产物
├── requirements.txt        Python 依赖
├── package.json            只有 start/serve/fetch 三个脚本
├── Dockerfile              容器化（可选，未用于当前线上）
├── deploy/                 服务器部署套件（nginx + systemd 模板）
├── .github/workflows/      定时抓数 + Pages 发布
├── README.md               完整技术文档（口径、数据源、部署细节）
└── HANDOVER.md             本文件
```

---

## 3. 改哪里：文件职责表

| 想改什么 | 改哪个文件 | 风险 |
|---|---|---|
| 颜色、间距、字号、卡片样式、响应式断点 | `public/styles.css` | 低 |
| 新增/删除区块、调整区块顺序 | `public/index.html` + `public/app.js` | 中，要同步改两处 |
| 某个模块怎么渲染、显示哪些数字 | `public/app.js` 对应的 `renderXxx()` | 中 |
| 文案、标签、行业分组、日历、工具箱条目 | `public/config.js` | 低 |
| 指标怎么算（三轴方向、卦限、库存、仓位、政策强度、六因子、风格、趋势） | `macro_v2.py` | 高，会动摇三张结论卡 |
| 数据从哪来、加新指标 | `fetch_data.py` | 高，需要 akshare 环境 |
| 接口行为、缓存、抓数调度 | `server.js` | 高，改错整站 404 |

---

## 4. 怎么跑起来验证

### 只看前端（最快，改样式的常规路径）

```bash
cd public && python3 -m http.server 8080     # 开 http://localhost:8080
```

前端有**静态降级**：先请求 `api/dashboard`，失败自动回退到同目录 `data.json`。所以单开 `public/` 就能看到完整真实页面。

### 跑整站（能看到真实接口、刷新按钮、抓数状态）

```bash
node server.js --port=7101                   # 只需 Node，零依赖
```

`python3` 未装 akshare 时会自动回退到仓库里的 `data.json` 快照，页面照常显示。

### 只重算结论（改了 `macro_v2.py` 后用这个验证）

```bash
python3 macro_v2.py                          # 读 data.json，重算并写回 macro_v2 段
```

纯标准库，不需要 pandas/numpy。**改完计算层必须跑通这一步**，否则前端拿到的还是旧结论。

### 全量重抓（改了 `fetch_data.py` 后用）

```bash
pip install -r requirements.txt
python3 fetch_data.py                        # 约 5–8 分钟
```

注意：**没有 `--dry-run`**，只能全量跑。跑完检查 `data.json` 的 `errors` 是否为空数组——非空说明有数据源挂了。

---

## 5. 绝对不能碰的

1. **`public/data.json` 和 `data.json` 是抓数产物，不是源码。** 里面是真的宏观数据，不要手改、不要重新格式化、不要"清理"。前端和后端全部依赖它的字段结构。
2. **不要改 `data.json` 的字段名。** 结构见第 7 节。
3. **改完 css/js 必须升 `index.html` 里的版本号**，否则浏览器吃缓存，你会以为"改了没生效"并反复改同一个地方：
   ```html
   <link rel="stylesheet" href="styles.css?v=5.5">   <!-- 改成 5.6 -->
   <script src="app.js?v=5.5"></script>              <!-- 改成 5.6 -->
   ```
4. **不要删 `config.js` 里已有的字段**，只增改。`app.js` 直接读这些键，缺一个就渲染成 `undefined` / `NaN`。
5. **不要把 `manual.json` 里的存准率（rrr）搬进去。** 那一项是 `fetch_data.py` 自动抓的，写进人工口径会被覆盖逻辑打架。

---

## 6. 这个项目的三条设计约束

改出来的东西要符合既有风格，否则会显得很突兀：

**① 卡片默认只显示结论，点击才展开细节。**
这是整站的交互铁律，没有例外。卡面只放：模块名 + 当前值 + 一句话结论。公式、判定规则、底层数值、走势图全部放进点击后的抽屉（`openDrawer()`）。不要在卡面堆参数。

**② 颜色语义是中国市场习惯。**
涨 / 利好 / 风险告警 = 红（`--up`），跌 / 利空 / 正常 = 绿（`--down`）。**不要用绿色表示"好"**，会对读者造成语义混乱。

**③ 结论必须同源。**
顶部三张结论卡和各模块显示的数字，必须读同一份 `macro_v2` 结果，不允许各算各的。改计算逻辑时尤其注意——只算一次，多处引用。

---

## 7. `data.json` 结构速查

```js
{
  updated_at: "2026-11-27 23:46:46",
  errors: [],                        // 抓数失败项，正常应为空数组

  series: {                          // 所有原始时序
    "cpi_yoy": { points: [["2026-10", 0.7], ...], unit: "%", freq: "M", n: 96 }
  },

  dims: {                            // 六维指标体系（正式值 + 高频代理）
    growth: {...}, inflation: {...}, liquidity: {...},
    policy: {...}, external: {...}, credit: {...}
  },

  macro_v2: {                        // 计算层输出，前端主要读这里
    axes:      { growth: {dir,...}, inflation: {...}, liquidity: {...} },
    octant:    { id, name, months_in, trail },       // 八分象限
    inventory: { stage, months_in },                 // 库存周期四阶段
    position:  { label, season, kitchin },           // 仓位建议
    policy:    { index, percentile, parts, series }, // 政策强度指数
    factors:   [...],                                // 六因子 z 分数
    style:     { score, label, signals },            // 风格（9 信号）
    trend:     { rows: [{ asset, available, broken, broken_parts }] },
    erp:       { value, pctile },
    industry:  { items: [...], n }                   // 31 个申万一级行业
  },

  manual: {                          // 政策工具箱人工口径
    updated: "2026-11-27",
    items: { "deficit": { v: "4.0% 左右", note, asof, src, auto } }
  }
}
```

`series[key].points` 是 `[日期字符串, 数值]` 数组，**可能为空**。所有渲染都要处理缺失——显示「数据更新中」，不要出现 `NaN`、`undefined`、空白或 `--%`。

---

## 8. 部署：能不能直接上线？

**分两条链路，权限完全不同。**

### 链路 A：GitHub Pages（自动化，但只发布静态快照）

```
push 到 main → .github/workflows/deploy-pages.yml → 发布 public/ 到 Pages
```

push 完等 1–2 分钟生效，地址是 `jiayigu-cpu.github.io/macro-research-board`。**只发布 `public/`，不含 Node 服务、不含自动抓数。**

### 链路 B：主站（手动，需要服务器凭证）

主站是云服务器上的 systemd 服务。**外部 AI 拿不到、也不该拿到凭证。**

```bash
# 纯前端改动：只覆盖静态文件，不用重启
scp public/{index.html,styles.css,app.js,config.js} ubuntu@<服务器>:/opt/macro-board/public/

# 改了 server.js 才需要重启
ssh ubuntu@<服务器> "sudo systemctl restart macro-board"

# 改了 fetch_data.py / macro_v2.py：下次抓数自动生效，或手动触发
curl -X POST "https://<域名>/api/refresh?force=1"
```

### 所以，现实的做法

外部 AI **只负责改文件并把改好的文件给你**，不要指望它部署。你自己（或用你惯用的助手）执行上传 + 校验，出事能立刻回滚。

让它自己验证效果完全够用：`python3 -m http.server` 起静态服务截图，或 `node server.js` 跑整站——都不需要服务器。

---

## 9. 交付时的话术模板

把这段连同压缩包一起发过去，能省掉大部分返工：

> 这是完整项目（宏观研究看板），先读 `HANDOVER.md`。
>
> 请改 <你的需求>。约束：
> 1. 纯静态前端 + 零依赖 Node，不要引入框架、构建工具或新依赖；
> 2. 卡面只放结论，细节放点击后的抽屉；
> 3. 颜色遵循 A 股习惯（红=涨/利好，绿=跌/利空）；
> 4. 数据缺失显示「数据更新中」，不能出现 NaN 或空白；
> 5. 改完把 `index.html` 里的 `?v=` 版本号加一，否则缓存不刷新；
> 6. `data.json` 只读，不要手改或重新格式化；
> 7. 用 `cd public && python3 -m http.server 8080` 跑起来，截图确认效果再交给我；
> 8. 交付时说明改了哪几个文件、每个文件改了什么、有没有碰计算层。
