# 宏观研究看板 v3

个人投资框架的前置宏观仪表盘。页面结构按研究流程组织：

**结论（核心判断 + 5 张可溯源的结论卡）→ 01 六维指标体系 → 02 宏观因子（Beta 与资产配置）→ 03 指标时序走势**

配色沿用 A 股行情终端习惯（红涨绿跌），支持夜间 / 日间两套主题。

---

## 换服务器 / 换网址：从 GitHub 重新部署

整份部署是可复制的脚本，仓库里没有任何东西依赖某一台具体的机器。
换机器时只需要一台干净的 Ubuntu 22.04 / 24.04（1 核 1G 起，磁盘 10G），然后：

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/jiayigu-cpu/macro-research-board.git
cd macro-research-board
sudo bash deploy/install.sh
```

跑完就有 `http://<公网IP>`。脚本按顺序做了这些事：

| 步骤 | 内容 |
| --- | --- |
| 依赖 | apt 装 `python3-venv`、`nginx`、`certbot`、`rsync`；没有 node 就装 |
| 代码 | `rsync` 到 `/opt/macro-board`，不覆盖已有的 `data.json` 和 `venv` |
| Python | 建 venv，按 `requirements.txt` 装 `akshare==1.18.60` |
| 常驻 | 写 `macro-board.service`，开机自启 + 崩溃 5 秒重启 |
| 反代 | nginx 抢 80，转发到 `127.0.0.1:8080`，开 gzip |
| 自检 | 打 `/api/status` 与首页，打印访问地址和后续步骤 |

脚本是幂等的：已经装好的机器重复执行，等于「拉最新代码 + 重装依赖 + 重启服务」。

可选参数全部走环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOMAIN` | 空 | 填了就自动签证书、开 HTTPS |
| `EMAIL` | 空 | 证书通知邮箱，`DOMAIN` 非空时建议填 |
| `APP_DIR` | `/opt/macro-board` | 安装目录 |
| `APP_USER` | `ubuntu` | 运行用户，不存在则用当前登录用户 |
| `PORT` | `8080` | Node 监听端口（仅本机） |
| `HTTP_PORT` | `80` | nginx 对外端口 |
| `SKIP_FETCH` | `0` | 设 `1` 则首次不抓数，直接用仓库快照 |

```bash
# 带域名一步到位
sudo DOMAIN=board.example.com EMAIL=me@example.com bash deploy/install.sh
```

### 脚本管不到的两步手工作业

云厂商的控制台没法用脚本代劳，换机器时这两处要自己点：

1. **防火墙放行端口**：腾讯云轻量 → 实例 → 防火墙 → 添加规则 → 自定义 TCP `80`、`443`、`8443`，来源 `0.0.0.0/0`。
   不放行的话服务在本机是好的、外网连不上，这个最容易误判成程序问题。
2. **域名 A 记录**：指向新机器的公网 IP。只换 IP 而沿用旧域名时，改这一条就够了。

### 网址变了怎么改

| 变更 | 要动的配置 |
| --- | --- |
| 换 IP | 只改 DNS 的 A 记录，机器上一个字不用动 |
| 换域名 | `sudo bash deploy/setup-https.sh 新域名 邮箱` |
| 撤掉 HTTPS 回 HTTP | `sudo DOMAIN= bash deploy/install.sh` |

## HTTPS

证书用 Let's Encrypt，免费，验证走 80 端口的 `/.well-known/acme-challenge/`（nginx 静态返回），
续期由 `certbot.timer` 每天两次自动跑，续完自动 reload nginx。

```bash
sudo bash deploy/setup-https.sh board.example.com you@example.com
```

**一个必须知道的坑**：广州这类国内地域，**未备案域名访问 443 会被云厂商拦**。
所以脚本同时监听 `443` 和 `8443`：443 不通就换 8443，证书是同一张，浏览器一样是绿锁，只是网址多带一个端口。
备案批下来后，`sudo HTTPS_PORT=443 bash deploy/setup-https.sh 域名` 重跑一次即可去掉端口。

如果 80 端口也被拦导致证书签不下来，脚本会打印 DNS 验证的替代方案（手动加一条 TXT 记录）；
DNS 托管在 DNSPod 的话，可以装 `certbot-dns-dnspod` 让续期也全自动。

## 当前线上部署

| 项目 | 值 |
| --- | --- |
| 地址 | http://114.132.50.154 |
| 机器 | 腾讯云轻量，广州四区，Ubuntu 24.04，2 核 2G |
| 安装目录 | `/opt/macro-board` |
| 进程 | systemd `macro-board.service`，用户 `ubuntu`，Node 监听 `127.0.0.1:8080` |
| 入口 | nginx 80 → 8080，gzip 已开（`styles.css` 38K → 10.9K） |
| Python | `/opt/macro-board/venv`，`akshare==1.18.60` |
| 数据 | 43 条序列，最近交易日以页面顶部标注为准 |

运维命令：

```bash
systemctl status macro-board       # 服务状态
systemctl restart macro-board      # 改完代码重启
journalctl -u macro-board -f       # 跟抓数日志
tail -f /var/log/nginx/macro-board.access.log
```

更新代码：`cd 仓库目录 && git pull && sudo bash deploy/install.sh`

**数据怎么自己变**：服务常驻，每小时自查一次——交易时段（工作日 9:00–15:30）数据超过 2 小时就重抓，
其余时段超过 6 小时重抓。抓数在后台跑约 1.5 分钟，不阻塞请求，抓完前端轮询自动接住。
所以数据更新**不需要任何定时任务**，也不需要在本机跑脚本。

---

## 本地开发

服务器上用 `deploy/install.sh` 部署；只想在本机看效果、改样式时，不用装 nginx 也不用 sudo：

```bash
npm run fetch        # 抓数，需 python3 + akshare，约 1.5–2 分钟
npm start            # 起服务，零依赖，只用 Node 内置模块
# 打开 http://127.0.0.1:7101
```

`server.js` 读 `PORT` / `HOST` 环境变量，默认 `7101` 与 `0.0.0.0`。
`AUTO_FETCH=1` 时才启用「数据过期自动重抓」，本地调试建议不开。
如果本机解释器里没有 akshare，「刷新数据」会提示当前展示的是快照，前端另有 `public/data.json` 静态兜底。

## 目录

```
deploy/           服务器部署套件（换机器只靠这个目录）
  install.sh          一键安装：依赖 + venv + systemd + nginx + 自检
  setup-https.sh      绑域名、签证书、开 443/8443、装续期钩子
  macro-board.service.tpl  systemd 单元模板
  nginx-http.conf.tpl / nginx-https.conf.tpl  nginx 配置模板
server.js         本地/托管服务（静态文件 + /api/dashboard + /api/refresh + /api/status）
fetch_data.py     akshare 取数 → data.json（一次请求同时产出读数、序列与派生指标）
data.json         最新快照（服务端权威数据源，/api/dashboard 读这个）
requirements.txt  Python 依赖，akshare 固定 1.18.60（见下方版本坑）
package.json      npm start / npm run fetch 快捷入口
Dockerfile        容器化备选方案（云托管用，轻量服务器不需要）
vercel.json       Vercel 静态托管配置（输出目录 public、data.json 不缓存）
.github/workflows 定时抓数（refresh.yml）与 Pages 发布（deploy-pages.yml）
public/
  index.html      骨架（结论 → 01 → 02 → 03 → 页脚 → 抽屉）
  styles.css      行情终端配色与版式
  charts.js       SVG 走势图引擎（多序列、面积、零轴、阶梯线、十字准星提示、双缓冲刷新）
  app.js          渲染逻辑：结论卡、六维、四象限散点、AQR、图表清单、定时轮询
  data.json       静态兜底快照（给 GitHub Pages 这类纯静态托管用，由根目录 data.json 复制）
  _headers        Cloudflare Pages / Netlify 的响应头（data.json 不缓存）
preview/          夜间 / 日间整页预览图
```

> **akshare 版本坑**：必须锁 `1.18.60`。1.20 系列把 12 个接口改名（如 `stock_zh_index_daily`
> 改成 `index_zh_daily_sina`），装新版会静默少抓——实测 43 条只回来 19 条，`asof` 变成 `None`，
> 而且不报错。`requirements.txt` 已固定版本，别升级。

## 页面结构

**结论区（页面最上方）**

- 核心判断：一句话结论 + 四个状态胶囊（宏观象限 / 全 A 估值 / 拥挤度 / 信用）
- 5 张结论卡：宏观象限→风格择时、流动性→估值中枢、信用→风险偏好、拥挤度→动量风险、AQR 四因子
- 每张卡点开是右侧抽屉：判断 → 关键取值 → 计算逻辑（编号步骤，带原始数字）→ 配置含义 → 数据来源

**01 宏观研究需要跟踪的指标体系**

按「增长 — 通胀 — 流动性 — 财政 — 外部 — 政策」六维搭建，每维两栏：

- **正式数据**：低频、权威，决定方向（PMI、工业增加值、CPI/PPI、M1/M2、财政收入、LPR…）
- **高频数据**：领先、可验证，决定节奏（螺纹钢、原油、SHIBOR、USD/CNY、美债、超长端利差…）

顶部六维总览条给出每维状态标签（收缩加深 / 通胀上行 / 资金活化 / 收入放缓 / 外部约束强 / 政策观望）。

**02 宏观因子：Beta 与资产配置**

| 小节 | 内容 |
| --- | --- |
| 2.1 因子择时 | 增长 × 通胀四象限矩阵（当前格高亮）+ 近 36 个月状态迁移散点 + 象限→风格因子映射表 |
| 2.2 流动性映射 | M1−M2 剪刀差、剩余流动性①（M1−PPI）、②（M2−名义 GDP）与全 A 估值中枢联动 |
| 2.3 拥挤度监控 | 成交额分位、波动率分位、成交集中度三项二阶因子 + 合成拥挤度 |
| 2.4 AQR 四因子 | Carry / Value / Momentum / Defensive 打分 + 跨资产映射表 |
| 2.5 因子总表 | 因子 → 构造方式 → 受益资产 → 当前读数 |

**03 指标时序走势**：30 张图，按六维 + 市场分组筛选，悬停出十字准星与数值。

## 数据口径

| 项目 | 口径 |
| --- | --- |
| 序列窗口 | 日频 250 个交易日，月频 48–60 个月，季频 16 个季度 |
| 最近交易日 | 以沪深 300 最后一个交易日为准（顶部标注） |
| 增长 / 通胀 z | PMI 与工业增加值、CPI 与 PPI 各自 36 个月滚动标准化后取均值 |
| 剩余流动性 ① | M1 同比 − PPI 同比（月度） |
| 剩余流动性 ② | M2 同比 − 名义 GDP 同比（季度名义 GDP 前向填充到月度） |
| ERP | `1/PE − 10Y 国债`，历史序列用当前 10Y 平移近似，保留形态与分位 |
| 社融 | akshare 社融接口不可用，以「新增人民币贷款」为主项代理（当月为负表示净偿还） |
| 拥挤度 | 成交额 MA20 三年分位 × 60% + 沪深 300 60 日波动率一年分位 × 40%；成交集中度（沪深 300 占两市成交）作二阶确认 |
| Defensive | 低波动分位 × 60% + (1 − 拥挤度) × 40% |

仍缺接口（页脚列出）：财政支出 / 专项债、MLF 与存准、公开市场净投放、DXY、VIX。
这几项 akshare 无稳定来源，建议接 Wind / FRED 后再补，当前如实标注「待接入」。

## 定时轮询（Polling）

页面不再依赖手动点「刷新数据」。默认每 60 秒拉一次数据接口，拿到新数据后整页增量刷新。

**怎么判断有没有新数据**：把 `updated_at` + 每条序列的「长度 + 末点日期 + 末点数值」拼成指纹，
指纹不变就静默跳过（不重绘、不打扰），变了才更新并提示。

**为什么不会闪屏**：`charts.js` 用双缓冲图层。刷新时不清空容器，而是把新图叠在上层淡入、
旧层淡出，中间没有任何空白帧——效果等同 ECharts `setOption` 的过渡，但不需要额外引入图表库。

**几个工程细节**

| 行为 | 处理方式 |
| --- | --- |
| 请求堆积 | 用 `setTimeout` 串联而非 `setInterval`，上一次请求回来才排下一次 |
| 流量 | 服务端返回 `ETag`，数据没变时回 `304`，轮询只花几百字节而不是整包 270 KB |
| 切后台 | `visibilitychange` 隐藏时停表，回到前台立刻补一次 |
| 失败 | 指数退避（60s → 120s → 240s → 上限 300s），首次失败提示一次，不刷屏 |
| 更新提示 | 顶部光带扫过 + 受影响的走势图描边 2.4 秒 + 底部 toast 列出变化项 |

**调整间隔**：URL 加 `?poll=30` 改为 30 秒，`?poll=0` 关闭自动刷新（只留手动按钮）。
页面顶部「自动刷新 · Ns」胶囊里能看到倒计时和当前状态（检查中 / 重试中 / 已暂停）。

## 在线刷新（点按钮真的取数）

「刷新数据」按钮分两级，按环境自动降级：

1. 先试服务端 `/api/refresh`——轻量服务器上装了 akshare，走这条能全量抓 43 条
2. 服务端不可用（GitHub Pages 这类纯静态托管，没有 Python），转由浏览器直连公开行情接口
   （`public/live.js`），不需要 Python、不需要 key、不需要代理

**服务端能刷的**：全部 43 条，和定时抓数是同一套 `fetch_data.py`，口径完全一致。

**浏览器兜底能刷的**

| 指标 | 数据源 | 说明 |
| --- | --- | --- |
| 沪深 300 | 腾讯 fqkline | 250 根完整日 K，与 `fetch_data.py` 同源 |
| 沪深 300 MA60 / 60 日波动率 | 由上面重算 | 口径与 Python 逐位对齐 |
| 螺纹钢、原油 | 东财 push2his，失败则降级为实时报价 | 尽力而为，取不到会提示并保留快照 |

**浏览器兜底刷不了的（保持快照）**

宏观月度（PMI、CPI/PPI、M1/M2、GDP）、利率（10Y/1Y、SHIBOR、LPR）、财政、外储、黄金、信用利差。
原因：这类数据要么是月度发布（一个月才变一次，快照足够），要么公开接口没有稳定的跨域来源。

成交额与成交集中度是刻意不更新的：东财算出来 13831 亿，快照口径 10301 亿，
两者不是同一套口径，替换会让图上出现无法解释的台阶。

**口径可验证**：`live.js` 的重算不是估算。用东财数据回算 2026-11-25，
收盘 3898.24、MA60 4262.97、vol60 13.82 与快照完全一致，误差为 0。

**几点限制**

- 刷新只影响当前这次页面，重开浏览器回到快照（不落盘，容器重启也会丢）
- 盘中点刷新拿到的是当时最新价，提示里会标「盘中」
- 期货数据源不稳定：实测东财域名会间歇性返回空响应（`ERR_EMPTY_RESPONSE`），
  代码做了 3 次重试 + 实时报价降级，仍失败就跳过该图并提示，不会影响其它图
- 双缓冲图层的旧层回收不依赖 `requestAnimationFrame`：页面在后台时 rAF 会被暂停，
  旧层会一直堆在 DOM 里（实测连刷几次后图层从 31 涨到 62 且不回落）

## 备选托管方案

主用方案是上面那台轻量服务器（有 Python，抓数完整、无冷启动）。下面几种留着当备份或对外分享用，
区别只在前端能不能拿到「全量 + 实时」的数据。

数据来自 akshare 抓的公开接口，只能在 Python 环境里跑，浏览器无法直连（没有 CORS 头）。
纯静态托管下的正确形态是：**CI 定时抓数 → 提交 JSON → 静态站托管 → 前端轮询 JSON**，
不需要服务器，也不用付任何费用，代价是只能拿到 CI 抓到的那一份快照。

### WorkBuddy 托管（自用地址）

```
线上地址  https://macro-research-board.app.workbuddy.host/?sharecode=EJWO7GTJ2G
```

这个地址不依赖 GitHub，陌生人用无痕浏览器可直接打开（实测：30 张图、31 个图层、5 张结论卡、
六维指标全部渲染，无报错，首屏 0.3–0.5 秒）。但有两条硬限制，忘了就会踩坑。

**限制一：链接必须整段复制，少一个字符就是 403**

只发域名（`...app.workbuddy.host/`）会返回 403「链接不完整，暂时无法访问」，必须带上
`?sharecode=EJWO7GTJ2G`。sharecode 等同于访问凭证——谁拿到链接谁就能看，不要贴到公开渠道。

另外**重新发布会生成新的分享码，旧链接随之失效**，别人存的书签就打不开了。所以对外长期分享
请用 GitHub Pages 的固定域名，这个地址只留作自用和临时给同事看。

**限制二：只有行情能在线刷，宏观仍靠重新发布**

线上沙箱没有 Python 与 akshare（`/api/status` 返回 `{"running":false,"python":false}`），
服务端抓数不可能。但「刷新数据」已改成浏览器直连公开行情接口（详见「在线刷新」一节）：

- 能刷：沪深 300（含 MA60 与 60 日波动率）、螺纹钢、原油
- 刷不了：宏观月度、利率、财政、外储等，仍是快照
- 刷新只影响当前这次页面，重开浏览器回到快照

所以要更新宏观数据，仍只有一条路：本机 `fetch_data.py` 抓全 → 重新发布（这会触发限制一）。

两个地址的分工：

| | WorkBuddy 托管 | GitHub Pages |
| --- | --- | --- |
| 链接 | 长，必须整段复制 | 干净短链，直接能开 |
| 访问门槛 | 需要 sharecode | 任何人打开即可 |
| 更新数据后 URL | **可能变**，要重新发一遍 | **永远不变** |
| 数据更新方式 | 本机抓数 + 重新发布 | 本机抓数 + push，自动重建 |
| 适合 | 自用、临时分享 | 长期对外分享、当正式站点 |

### GitHub Pages（已上线）

```
线上地址   https://jiayigu-cpu.github.io/macro-research-board/
仓库       https://github.com/jiayigu-cpu/macro-research-board
```

仓库里两条流水线：

```
.github/workflows/deploy-pages.yml  push 到 main 就发布 public/
.github/workflows/refresh.yml       工作日 08:40 / 11:40 / 15:40（北京）抓数
                                    → 提交 data.json → 同一条流水线内重新发布
```

`refresh.yml` 之所以自己走完部署、而不是靠 push 触发 `deploy-pages`，是因为
Actions 用 `GITHUB_TOKEN` 提交的 push 不会再触发其它 workflow（GitHub 的防递归机制），
只在 push 阶段接部署会导致定时抓数后线上数据不更新。

**定时抓数的已知限制**：这条流水线曾经只回来 19 条（本机 43 条），M1/M2、LPR、SHIBOR、
沪深 300、成交额、外储、美债全部为空。当时判断是「runner 在境外，抓国内接口失败」，
**这个判断是错的**——真正原因是 runner 上装到了 akshare 1.20 系列，
接口改名后静默返回空。固定到 `1.18.60` 后境外 runner 也能抓全。
流水线仍保留完整性门槛：本次抓到的序列数低于上次 85% 就判定失败、保留旧快照并告警，
宁可数据不更新，也不让线上变成一个缺数据的看板。这是兜底，不是常态。

纯静态托管下**数据更新靠本机跑**：

```bash
/usr/local/bin/python3 fetch_data.py   # 需要装了 akshare==1.18.60 的解释器
cp data.json public/data.json
git commit -am "chore: 更新宏观数据" && git push
```

改用自己的仓库时，只需：

1. 推到你的仓库 `main` 分支
2. Settings → Pages → Source 选 **GitHub Actions**
3. Actions 里手动跑一次 `deploy-pages`，或等下次 push 自动发布

### Cloudflare Pages / Vercel

两者都只需要「静态目录 = `public`、构建命令留空」：

- **Cloudflare Pages**：构建命令空，输出目录 `public`。仓库里的 `public/_headers` 已声明
  `data.json` 走 `no-cache`，避免 CDN 缓存让轮询读到旧快照
- **Vercel**：直接用仓库根目录导入，`vercel.json` 已指定 `outputDirectory: public`
  与 `data.json` 的 `no-cache` 头

定时抓数可以复用同一份 GitHub Actions（仓库放在 GitHub 即可），或用 Cloudflare 的
Cron Triggers / Vercel Cron 触发一个跑 `fetch_data.py` 的接口。纯静态方案下前者最省事。

### 如果不想要 CI

本地 `python3 fetch_data.py` 后把 `data.json` 复制到 `public/`，再手动上传即可。
页面照常轮询，只是数据不会自己变。
