# -*- coding: utf-8 -*-
"""宏观研究看板数据管道 v2.0
akshare 取数 → 六维指标 + 宏观因子 + 时序序列 → data.json
原则：每个数据集只拉一次，同时产出「当前读数」与「走势序列」；
取不到真实数据的一律标 pending，绝不填估计值。
"""
import json, os, re, time, traceback, io, urllib.request
from datetime import datetime, timedelta
import akshare as ak
import pandas as pd
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "data.json")
TODAY = datetime.now()

data = {"updated_at": TODAY.strftime("%Y-%m-%d %H:%M:%S"),
        "errors": [], "dims": {}, "factors": {}, "cards": [], "series": {},
        "sources": {}, "checks": {}}
SER = data["series"]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"


def http_get(url, referer=None, timeout=15):
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    return urllib.request.urlopen(
        urllib.request.Request(url, headers=headers), timeout=timeout).read()


# ---- Tushare（可选增强）------------------------------------------------
# 有 token 就用它取美债曲线（字段规范，不怕上游接口改名）；没有则自动走官方源。
# 获取方式：tushare.pro 注册即送 120 积分，足够 us_tycr / shibor。
TS_TOKEN = os.environ.get("TUSHARE_TOKEN", "").strip()
if not TS_TOKEN:
    for _p in (os.path.join(BASE, ".tushare_token"),
               os.path.expanduser("~/.tushare_token")):
        try:
            if os.path.exists(_p):
                TS_TOKEN = open(_p).read().strip()
                break
        except Exception:
            pass
TS = None
if TS_TOKEN:
    try:
        import tushare as _ts
        _ts.set_token(TS_TOKEN)
        TS = _ts.pro_api()
        print("[info] Tushare 已启用")
    except Exception as _e:
        print("[warn] Tushare 初始化失败，回退官方源：" + str(_e)[:80])



# ---------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------
def parse_cn(s):
    s = str(s).strip()
    m = re.match(r"^(\d{4})年(\d{1,2})月", s)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), 1)
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.match(r"^(\d{4})(\d{2})$", s)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), 1)
    return None


def pctile(series, value, window=None):
    s = pd.Series(series).dropna().astype(float)
    if window:
        s = s.tail(window)
    if len(s) < 30 or value is None or pd.isna(value):
        return None
    return round(float((s <= value).mean()), 4)


def spot_future(code):
    """新浪期货实时行情 → (日期, 最新价)。日线接口收盘后不更新，用实时值补当日 bar。"""
    try:
        req = urllib.request.Request(
            "https://hq.sinajs.cn/list=" + code,
            headers={"User-Agent": "Mozilla/5.0",
                     "Referer": "https://finance.sina.com.cn"})
        raw = urllib.request.urlopen(req, timeout=8).read().decode("gbk", "ignore")
        f = raw.split('"')[1].split(",")
        d, px = f[17].strip(), float(f[8])
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d) and px > 0:
            return d, px
    except Exception:
        pass
    return None


def append_today(df, date_col, close_col, spot_code):
    """日线缺当日、而实时行情已有当日成交价时，补一根当日 bar。"""
    s = spot_future(spot_code)
    if not s:
        return df
    d, px = s
    if d <= pd.to_datetime(df[date_col].iloc[-1]).strftime("%Y-%m-%d"):
        return df
    row = {c: np.nan for c in df.columns}
    row[date_col] = pd.Timestamp(d)
    row[close_col] = px
    return pd.concat([df, pd.DataFrame([row])], ignore_index=True)


def put(key, labels, values, unit="", freq="D", nd=2, keep=260):
    """写入一条时序序列（自动跳过缺失值、限制长度）"""
    pts = []
    for l, v in zip(labels, values):
        if v is None:
            continue
        try:
            fv = float(v)
        except Exception:
            continue
        if pd.isna(fv):
            continue
        pts.append([str(l), round(fv, nd)])
    if not pts:
        return
    pts = pts[-keep:]
    SER[key] = {"points": pts, "unit": unit, "freq": freq, "nd": nd,
                "first": pts[0][0], "last": pts[-1][0], "n": len(pts)}


def block(name, fn):
    """统一异常捕获：一个数据集失败不影响整体"""
    try:
        return fn()
    except Exception as e:
        msg = f"{type(e).__name__}: {str(e)[:130]}"
        data["errors"].append({name: msg})
        print("ERR", name, msg)
        return None


def mlab(dt):
    return dt.strftime("%Y-%m")


def dlab(dt):
    return dt.strftime("%Y-%m-%d")


def pending(note):
    return {"pending": True, "note": note}


# =====================================================================
# 0. 交易日基准
# =====================================================================
def em_index(code, days=1200):
    """东财指数日线。相比新浪/腾讯日线，东财在收盘后即可返回当日 bar。"""
    start = (TODAY - timedelta(days=days)).strftime("%Y%m%d")
    df = ak.index_zh_a_hist(symbol=code, period="daily", start_date=start)
    df = df.rename(columns={"日期": "date", "开盘": "open", "收盘": "close",
                            "最高": "high", "最低": "low",
                            "成交量": "volume", "成交额": "amount"})
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)


def get_hs():
    try:
        df = em_index("000300", 900)
        data["sources"]["index_daily"] = "东方财富 index_zh_a_hist"
        return df
    except Exception as e:
        print("[warn] 东财指数接口失败，回退新浪：" + str(e)[:80])
        df = ak.stock_zh_index_daily(symbol="sh000300")
        df["date"] = pd.to_datetime(df["date"])
        data["sources"]["index_daily"] = "新浪 stock_zh_index_daily（回退，当日不可用）"
        return df.sort_values("date").reset_index(drop=True)


HS = block("hs300_index", get_hs)
if HS is not None and len(HS):
    data["asof"] = {"trade_date": dlab(HS.iloc[-1]["date"]),
                    "label": "最近交易日（沪深 300）"}


# =====================================================================
# 1. 增长
# =====================================================================
growth = {"official": [], "highfreq": []}

# ---- 官方制造业 PMI ----
def pmi_block():
    df = ak.macro_china_pmi()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "制造业-指数"]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    v, pv = float(last["制造业-指数"]), float(prev["制造业-指数"])
    put("pmi", [mlab(x) for x in df["_d"]], df["制造业-指数"], freq="M", nd=1, keep=48)
    put("pmi_non", [mlab(x) for x in df["_d"]], df["非制造业-指数"], freq="M", nd=1, keep=48)
    return {"name": "官方制造业 PMI", "date": mlab(last["_d"]),
            "value": round(v, 1), "unit": "",
            "mom": round(v - pv, 1),
            "mom_series": "up" if v >= pv else "down",
            "read": "扩张区间" if v >= 50 else "收缩区间",
            "src": "国家统计局 / 东方财富"}


r = block("pmi", pmi_block)
growth["official"].append(r if r else {"name": "官方制造业 PMI", "error": True})
time.sleep(1)

# ---- 工业增加值同比 ----
def iav_block():
    df = ak.macro_china_gyzjz()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "同比增长"]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    v, pv = float(last["同比增长"]), float(prev["同比增长"])
    put("iav", [mlab(x) for x in df["_d"]], df["同比增长"], unit="%", freq="M", keep=48)
    put("iav_cum", [mlab(x) for x in df["_d"]], df["累计增长"], unit="%", freq="M", keep=48)
    return {"name": "规模以上工业增加值同比", "date": mlab(last["_d"]),
            "value": round(v, 1), "unit": "%", "prev": round(pv, 1),
            "read": "环比回升" if v >= pv else "环比回落",
            "src": "国家统计局"}


r = block("iav", iav_block)
growth["official"].append(r if r else {"name": "规模以上工业增加值同比", "error": True})
time.sleep(1)

# ---- 螺纹钢主力（周期高频代理）----
def rb_block():
    df = ak.futures_main_sina(symbol="RB0")
    df["日期"] = pd.to_datetime(df["日期"])
    df = df.sort_values("日期").reset_index(drop=True)
    df = append_today(df, "日期", "收盘价", "nf_RB0")
    c = df["收盘价"].astype(float)
    ma60 = c.rolling(60).mean()
    last = df.iloc[-1]
    v = float(c.iloc[-1])
    days = min(250, len(df))
    put("rb", [dlab(x) for x in df["日期"].tail(days)], c.tail(days),
        unit="元/吨", nd=0, keep=250)
    put("rb_ma60", [dlab(x) for x in df["日期"].tail(days)], ma60.tail(days),
        unit="元/吨", nd=0, keep=250)
    return {"name": "螺纹钢主力连续", "date": dlab(last["日期"]),
            "value": round(v, 0), "unit": "元/吨",
            "chg_20d_pct": round((v / float(c.iloc[-21]) - 1) * 100, 1),
            "vs_ma60": round((v / float(ma60.iloc[-1]) - 1) * 100, 1),
            "read": "强于 60 日均线" if v >= ma60.iloc[-1] else "弱于 60 日均线",
            "src": "新浪期货 + 当日实时补价"}


r = block("rb", rb_block)
growth["highfreq"].append(r if r else pending("螺纹钢接口不可用；建议接入 Wind / Mysteel 高炉开工率、30 城商品房成交"))
data["dims"]["growth"] = growth
time.sleep(1)

# =====================================================================
# 2. 通胀
# =====================================================================
infl = {"official": [], "highfreq": []}


def cpi_block():
    df = ak.macro_china_cpi()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "全国-同比增长"]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    v, pv = float(last["全国-同比增长"]), float(prev["全国-同比增长"])
    put("cpi", [mlab(x) for x in df["_d"]], df["全国-同比增长"], unit="%", freq="M", keep=48)
    put("cpi_mom", [mlab(x) for x in df["_d"]], df["全国-环比增长"], unit="%", freq="M", keep=48)
    return {"name": "CPI 同比", "date": mlab(last["_d"]), "value": round(v, 2), "unit": "%",
            "prev": round(pv, 2), "mom": round(v - pv, 2),
            "read": "同比上行" if v >= pv else "同比下行",
            "src": "国家统计局 / 东方财富"}


r = block("cpi", cpi_block)
infl["official"].append(r if r else {"name": "CPI 同比", "error": True})
time.sleep(1)


def ppi_block():
    df = ak.macro_china_ppi()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "当月同比增长"]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    v, pv = float(last["当月同比增长"]), float(prev["当月同比增长"])
    put("ppi", [mlab(x) for x in df["_d"]], df["当月同比增长"], unit="%", freq="M", keep=48)
    return {"name": "PPI 同比", "date": mlab(last["_d"]), "value": round(v, 2), "unit": "%",
            "prev": round(pv, 2), "mom": round(v - pv, 2),
            "read": "同比回升" if v >= pv else "同比回落",
            "src": "国家统计局 / 东方财富"}


r = block("ppi", ppi_block)
infl["official"].append(r if r else {"name": "PPI 同比", "error": True})
time.sleep(1)


def sc_block():
    df = ak.futures_main_sina(symbol="SC0")
    df["日期"] = pd.to_datetime(df["日期"])
    df = df.sort_values("日期").reset_index(drop=True)
    df = append_today(df, "日期", "收盘价", "nf_SC0")
    c = df["收盘价"].astype(float)
    days = min(250, len(df))
    put("sc", [dlab(x) for x in df["日期"].tail(days)], c.tail(days),
        unit="元/桶", nd=1, keep=250)
    v = float(c.iloc[-1])
    chg = round((v / float(c.iloc[-21]) - 1) * 100, 1)
    return {"name": "INE 原油主力", "date": dlab(df.iloc[-1]["日期"]),
            "value": round(v, 1), "unit": "元/桶", "chg_20d_pct": chg,
            "read": "油价走强" if chg > 0 else "油价走弱", "src": "新浪期货 + 当日实时补价"}


r = block("sc", sc_block)
infl["highfreq"].append(r if r else pending("原油期货接口不可用；建议接入 Wind：布伦特原油、南华工业品指数"))
data["dims"]["inflation"] = infl
time.sleep(1)

# =====================================================================
# 3. 流动性
# =====================================================================
liq = {"official": [], "highfreq": []}


def money_block():
    df = ak.macro_china_money_supply()
    m2c, m1c = "货币和准货币(M2)-同比增长", "货币(M1)-同比增长"
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", m2c, m1c]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    m1, m2 = float(last[m1c]), float(last[m2c])
    p1, p2 = float(prev[m1c]), float(prev[m2c])
    sc, psc = m1 - m2, p1 - p2
    labels = [mlab(x) for x in df["_d"]]
    put("m1", labels, df[m1c], unit="%", freq="M", keep=60)
    put("m2", labels, df[m2c], unit="%", freq="M", keep=60)
    put("scissors", labels, df[m1c].astype(float) - df[m2c].astype(float),
        unit="pct", freq="M", keep=60)
    return {"name": "M1 / M2 同比", "date": mlab(last["_d"]),
            "m1": round(m1, 1), "m2": round(m2, 1), "unit": "%",
            "scissors": round(sc, 1), "scissors_prev": round(psc, 1),
            "m1_trend": "回升" if m1 >= p1 else "回落",
            "read": "资金活化改善" if sc >= psc else "活化放缓",
            "src": "中国人民银行"}


r = block("money", money_block)
liq["official"].append(r if r else {"name": "M1 / M2 同比", "error": True})
time.sleep(1)


def credit_block():
    df = ak.macro_china_new_financial_credit()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "当月"]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    v, pv = float(last["当月"]), float(prev["当月"])
    labels = [mlab(x) for x in df["_d"]]
    put("credit_inc", labels, df["当月"], unit="亿元", nd=0, freq="M", keep=60)
    put("credit_cum_yoy", labels, df["累计-同比增长"], unit="%", freq="M", keep=60)
    return {"name": "新增人民币贷款（社融主项）", "date": mlab(last["_d"]),
            "value": round(v, 0), "unit": "亿元", "prev": round(pv, 0),
            "cum_yoy": round(float(last["累计-同比增长"]), 1),
            "read": ("当月净偿还" if v < 0 else "当月净投放") +
                    ("，信用收缩" if float(last["累计-同比增长"]) < 0 else "，信用扩张"),
            "src": "中国人民银行"}


r = block("credit", credit_block)
liq["official"].append(r if r else {"name": "新增人民币贷款（社融主项）", "error": True})
time.sleep(1)


def shibor_block(ind, key, disp):
    df = ak.rate_interbank(market="上海银行同业拆借市场", symbol="Shibor人民币", indicator=ind)
    df["报告日"] = pd.to_datetime(df["报告日"])
    df = df.dropna(subset=["利率"]).sort_values("报告日").reset_index(drop=True)
    r = df["利率"].astype(float)
    days = min(250, len(df))
    put(key, [dlab(x) for x in df["报告日"].tail(days)], r.tail(days),
        unit="%", nd=3, keep=250)
    v = float(r.iloc[-1])
    p1y = pctile(r.tail(250), v)
    return {"name": f"SHIBOR {disp}", "date": dlab(df.iloc[-1]["报告日"]),
            "value": round(v, 3), "unit": "%", "pctile_1y": p1y,
            "read": "资金价格低位" if (p1y or .5) < .35 else ("资金价格高位" if (p1y or .5) > .65 else "资金价格中性"),
            "src": "全国银行间同业拆借中心"}


for ind, key, disp in [("隔夜", "shibor_on", "隔夜"), ("1周", "shibor_7d", "7天")]:
    r = block(f"shibor_{key}", lambda i=ind, k=key, d=disp: shibor_block(i, k, d))
    liq["highfreq"].append(r if r else pending("SHIBOR 接口不可用"))
    time.sleep(1)

data["dims"]["liquidity"] = liq

# ---- 财政 ----
fisc = {}


def fiscal_block():
    df = ak.macro_china_czsr()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "当月"]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    labels = [mlab(x) for x in df["_d"]]
    put("fiscal_rev", labels, df["当月"], unit="亿元", nd=0, freq="M", keep=60)
    cum = df["累计-同比增长"].astype(float)
    put("fiscal_cum_yoy", labels, cum, unit="%", freq="M", keep=60)
    cy_now, cy_prev = float(last["累计-同比增长"]), float(prev["累计-同比增长"])
    return {"name": "财政收入（当月 / 累计同比）", "date": mlab(last["_d"]),
            "value": round(float(last["当月"]), 0), "unit": "亿元",
            "cum_yoy": round(cy_now, 1), "cum_yoy_prev": round(cy_prev, 1),
            "read": ("财政发力，收入端改善" if cy_now > cy_prev else
                     "财政收入增速回落，支出强度受限"),
            "src": "财政部"}


r = block("fiscal", fiscal_block)
fisc.update(r or {})
time.sleep(1)

# =====================================================================
# 4. 外部
# =====================================================================
ext = {"official": [], "highfreq": []}


def fxgold_block():
    df = ak.macro_china_fx_gold()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "国家外汇储备-数值"]).sort_values("_d")
    last, prev = df.iloc[-1], df.iloc[-2]
    labels = [mlab(x) for x in df["_d"]]
    put("fxres", labels, df["国家外汇储备-数值"], unit="亿美元", nd=0, freq="M", keep=60)
    put("gold", labels, df["黄金储备-数值"], unit="", nd=0, freq="M", keep=60)
    gold_v = last["黄金储备-数值"]
    return {"name": "外汇储备 / 黄金储备", "date": mlab(last["_d"]),
            "fx_yi_usd": round(float(last["国家外汇储备-数值"]), 0),
            "fx_prev": round(float(prev["国家外汇储备-数值"]), 0),
            "fx_yoy": round(float(last["国家外汇储备-同比"]), 1),
            "gold_wan_oz": None if pd.isna(gold_v) else round(float(gold_v), 0),
            "read": "外储同比增加" if float(last["国家外汇储备-同比"]) >= 0 else "外储同比减少",
            "src": "中国人民银行"}


r = block("fxgold", fxgold_block)
ext["official"].append(r if r else {"name": "外汇储备 / 黄金储备", "error": True})
time.sleep(1)


def boc_block():
    start = (TODAY - timedelta(days=420)).strftime("%Y%m%d")
    df = ak.currency_boc_sina(symbol="美元", start_date=start, end_date=TODAY.strftime("%Y%m%d"))
    df["日期"] = pd.to_datetime(df["日期"])
    df = df.dropna(subset=["央行中间价"]).sort_values("日期").reset_index(drop=True)
    mid = df["央行中间价"].astype(float) / 100.0
    days = min(250, len(df))
    put("usdcny", [dlab(x) for x in df["日期"].tail(days)], mid.tail(days),
        unit="", nd=4, keep=250)
    v = float(mid.iloc[-1])
    chg = round((v / float(mid.iloc[0]) - 1) * 100, 2)
    return {"name": "USD/CNY 中间价", "date": dlab(df.iloc[-1]["日期"]),
            "value": round(v, 4), "unit": "",
            "chg_period_pct": chg,
            "read": "人民币区间波动" if abs(chg) < 2 else ("人民币走弱" if chg > 0 else "人民币走强"),
            "src": "中国银行 / 央行中间价"}


r = block("usdcny", boc_block)
ext["highfreq"].append(r if r else pending("USD/CNY 接口不可用"))


def _us_curve_treasury():
    """美国财政部官方日频收益率曲线（国内可达、无需 key）。"""
    frames = []
    for y in (TODAY.year - 1, TODAY.year):
        url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
               f"daily-treasury-rates.csv/{y}/all?type=daily_treasury_yield_curve"
               f"&field_tdr_date_value={y}&page&_format=csv")
        txt = http_get(url).decode("utf-8", "ignore")
        frames.append(pd.read_csv(io.StringIO(txt)))
    df = pd.concat(frames).drop_duplicates(subset=["Date"])
    df["Date"] = pd.to_datetime(df["Date"], format="%m/%d/%Y")
    out = pd.DataFrame({"date": df["Date"]})
    for col, name in [("2 Yr", "y2"), ("10 Yr", "y10"), ("30 Yr", "y30")]:
        out[name] = pd.to_numeric(df[col], errors="coerce").values
    return out.dropna(subset=["y10"]).sort_values("date").reset_index(drop=True)


def _us_curve_tushare():
    """同样的曲线，走 Tushare us_tycr（120 积分即可）。"""
    df = TS.us_tycr(start_date="20230101", end_date=TODAY.strftime("%Y%m%d"))
    df = df.rename(columns={"date": "date", "y2": "y2", "y10": "y10", "y30": "y30"})
    df["date"] = pd.to_datetime(df["date"])
    for c in ("y2", "y10", "y30"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[["date", "y2", "y10", "y30"]].dropna(subset=["y10"]).sort_values("date").reset_index(drop=True)


def usrate_block():
    """美债曲线。中美国债利差需要中债同日数据，在 yield_block 之后由 fill_cnus10 补算。"""
    df, src = None, ""
    if TS is not None:
        try:
            df, src = _us_curve_tushare(), "Tushare us_tycr"
        except Exception as e:
            print("[warn] Tushare 美债失败，回退财政部：" + str(e)[:70])
    if df is None or not len(df):
        df, src = _us_curve_treasury(), "美国财政部收益率曲线"
    data["sources"]["us_treasury"] = src

    days = min(250, len(df))
    tail = df.tail(days)
    labels = [dlab(x) for x in tail["date"]]
    put("us10y", labels, tail["y10"], unit="%", freq="D", nd=2, keep=250)
    put("us2y", labels, tail["y2"], unit="%", freq="D", nd=2, keep=250)
    put("us30y", labels, tail["y30"], unit="%", freq="D", nd=2, keep=250)

    last = df.iloc[-1]
    y2, y10, y30 = float(last["y2"]), float(last["y10"]), float(last["y30"])
    return {"name": "美债 10Y / 中美利差", "date": dlab(last["date"]),
            "us10y": round(y10, 2), "curve_2s10s": round(y10 - y2, 2),
            "curve_10s30s": round(y30 - y10, 2),
            "read": ("美债曲线倒挂，衰退预期偏强" if y10 - y2 < 0 else
                     "美债曲线陡化，财政与通胀溢价上升" if y10 - y2 > 1 else "美债曲线形态中性"),
            "src": src}


US_ROW = block("usrate", usrate_block)
ext["highfreq"].append(US_ROW if US_ROW else pending("美债收益率接口不可用"))
data["dims"]["external"] = ext
time.sleep(1)

# =====================================================================
# 5. 政策
# =====================================================================
pol = {"official": [], "highfreq": []}


def lpr_block():
    df = ak.macro_china_lpr()
    df["TRADE_DATE"] = pd.to_datetime(df["TRADE_DATE"])
    df = df.sort_values("TRADE_DATE").reset_index(drop=True)
    last, prev = df.iloc[-1], df.iloc[-2]
    labels = [dlab(x) for x in df["TRADE_DATE"]]
    put("lpr1y", labels, df["LPR1Y"], unit="%", freq="M", nd=2, keep=60)
    put("lpr5y", labels, df["LPR5Y"], unit="%", freq="M", nd=2, keep=60)
    c1 = round(float(last["LPR1Y"]) - float(prev["LPR1Y"]), 2)
    c5 = round(float(last["LPR5Y"]) - float(prev["LPR5Y"]), 2)
    return {"name": "LPR 1Y / 5Y 报价", "date": dlab(last["TRADE_DATE"]),
            "lpr1y": float(last["LPR1Y"]), "lpr5y": float(last["LPR5Y"]), "unit": "%",
            "chg_1y": c1, "chg_5y": c5,
            "read": "降息周期" if (c1 < 0 or c5 < 0) else "报价持平",
            "src": "全国银行间同业拆借中心"}


r = block("lpr", lpr_block)
pol["official"].append(r if r else {"name": "LPR 1Y / 5Y 报价", "error": True})
pol["official"].append(pending("MLF 利率、存款准备金率、结构性工具额度：akshare 无接口，建议按央行公告手动维护"))
pol["highfreq"].append(pending("央行公开市场净投放（7 天逆回购）：建议接入央行官网或 Wind，日频"))
data["dims"]["policy"] = pol
time.sleep(1)

# =====================================================================
# 6. 利率曲线与信用利差
# =====================================================================
def yield_block():
    frames, end_d = [], TODAY
    for _ in range(6):
        start_d = max(end_d - timedelta(days=90), TODAY - timedelta(days=420))
        df = ak.bond_china_yield(start_date=start_d.strftime("%Y%m%d"),
                                 end_date=end_d.strftime("%Y%m%d"))
        if df is not None and len(df):
            frames.append(df)
        if start_d <= TODAY - timedelta(days=420):
            break
        end_d = start_d - timedelta(days=1)
        time.sleep(1.2)
    if not frames:
        raise RuntimeError("收益率曲线全部分块为空")
    df = pd.concat(frames).drop_duplicates(subset=["曲线名称", "日期"])
    df["日期"] = pd.to_datetime(df["日期"])
    gz = df[df["曲线名称"] == "中债国债收益率曲线"].sort_values("日期").reset_index(drop=True)
    zp = df[df["曲线名称"] == "中债中短期票据收益率曲线(AAA)"].sort_values("日期").reset_index(drop=True)
    if gz.empty:
        raise RuntimeError("国债曲线为空")

    labels = [dlab(x) for x in gz["日期"]]
    y1 = gz["1年"].astype(float); y10 = gz["10年"].astype(float)
    put("y10", labels, y10, unit="%", freq="D", nd=3, keep=250)
    put("y1", labels, y1, unit="%", freq="D", nd=3, keep=250)
    put("slope", labels, y10 - y1, unit="pct", freq="D", nd=3, keep=250)

    out = {}
    if not zp.empty:
        j = pd.merge(zp[["日期", "3年", "5年"]], gz[["日期", "3年", "5年"]],
                     on="日期", suffixes=("_c", "_g")).dropna()
        if len(j):
            sp3 = j["3年_c"].astype(float) - j["3年_g"].astype(float)
            put("cspread", [dlab(x) for x in j["日期"]], sp3, unit="pct", freq="D", nd=3, keep=250)
            out["credit_spread_3y"] = round(float(sp3.iloc[-1]), 2)
            out["credit_spread_pctile_1y"] = pctile(sp3.tail(250), float(sp3.iloc[-1]))

    g = gz.iloc[-1]
    out.update({
        "date": dlab(g["日期"]),
        "y1": round(float(g["1年"]), 3), "y3": round(float(g["3年"]), 3),
        "y5": round(float(g["5年"]), 3), "y10": round(float(g["10年"]), 3),
        "y30": round(float(g["30年"]), 3),
        "y10_pctile_1y": pctile(y10.tail(250), float(g["10年"])),
        "slope_10_1": round(float(g["10年"]) - float(g["1年"]), 3),
        "slope_30_10": round(float(g["30年"]) - float(g["10年"]), 3),
        "y10_chg_1m": round(float(g["10年"]) - float(y10.iloc[-22]), 3) if len(gz) > 22 else None,
        "src": "中债估值中心",
    })
    return out


Y = block("yields", yield_block) or {}
data["factors"]["yields"] = Y


def fill_cnus10():
    """中债 10Y − 美债 10Y。两条曲线各自独立取数后按共同交易日对齐，
    避免旧写法里 dropna 把「中债已出、美债未出」的那天整行删掉。"""
    cn = {d: v for d, v in (SER.get("y10", {}).get("points") or [])}
    us = {d: v for d, v in (SER.get("us10y", {}).get("points") or [])}
    common = sorted(set(cn) & set(us))
    if not common:
        data["errors"].append("中美国债利差：两条曲线无共同交易日")
        return
    rows = [(d, round(cn[d] - us[d], 2)) for d in common]
    put("cnus10", [d for d, _ in rows], [s for _, s in rows], unit="pct", freq="D", nd=2, keep=250)
    d0, sp = rows[-1]
    if isinstance(US_ROW, dict):
        US_ROW.setdefault("curve_read", US_ROW.get("read"))
        US_ROW["cnus10"] = sp
        US_ROW["cn10"] = round(cn[d0], 3)
        US_ROW["cnus_date"] = d0
        US_ROW["read"] = ("中美利差深度倒挂，汇率与外资流入承压" if sp < -0.8 else
                          "中美利差小幅倒挂，外部约束偏弱" if sp < 0 else
                          "中美利差为正，汇率压力较小")


fill_cnus10()
time.sleep(1)

# ---- 财政维度（正式：财政收入；高频：超长端利差＝政府债供给压力代理）----
fiscal = {"official": [], "highfreq": []}
if fisc:
    fiscal["official"].append(fisc)
else:
    fiscal["official"].append(pending("财政收入接口不可用"))
fiscal["official"].append(pending("财政支出 / 专项债发行：akshare 无接口，建议接入财政部月报或 Wind"))
if Y.get("slope_30_10") is not None:
    s3010 = Y["slope_30_10"]
    fiscal["highfreq"].append({
        "name": "超长端利差 30Y − 10Y", "date": Y.get("date"),
        "value": round(s3010, 3), "unit": "pp",
        "read": ("超长端供给压力大，财政放量交易" if s3010 > 0.45 else
                 "超长端利差压缩，配置盘需求强" if s3010 < 0.2 else "超长端利差中性"),
        "src": "中债估值"})
else:
    fiscal["highfreq"].append(pending("30Y/10Y 国债收益率接口不可用"))
data["dims"]["fiscal"] = fiscal

# =====================================================================
# 7. 估值（PE / ERP）
# =====================================================================
def pe_block():
    hs = ak.stock_index_pe_lg(symbol="沪深300")
    hs["日期"] = pd.to_datetime(hs["日期"])
    hs = hs.dropna(subset=["滚动市盈率"]).sort_values("日期").reset_index(drop=True)
    hs = hs.drop_duplicates(subset=["日期"], keep="last")
    pe_s = hs["滚动市盈率"].astype(float)
    mlabels = [mlab(x) for x in hs["日期"]]
    put("pe300", mlabels, pe_s, unit="倍", nd=2, freq="M", keep=60)
    # 沪深 300 ERP 需要 10Y 国债对齐
    erp_now, erp_pct = None, None
    if Y.get("y10") is not None:
        y10_now = Y["y10"]
        erp_now = round(1 / float(pe_s.iloc[-1]) * 100 - y10_now, 2)
        put("erp", mlabels, 1 / pe_s * 100 - y10_now, unit="%", nd=2, freq="M", keep=60)
        erp_pct = pctile((1 / pe_s * 100 - y10_now).tail(250), 1 / float(pe_s.iloc[-1]) * 100 - y10_now)
    out = {"date": dlab(hs.iloc[-1]["日期"]),
           "hs300_pe_ttm": round(float(pe_s.iloc[-1]), 2),
           "hs300_pe_median": round(float(hs.iloc[-1]["滚动市盈率中位数"]), 2),
           "pe_pctile_1y": pctile(pe_s.tail(250), float(pe_s.iloc[-1])),
           "erp": erp_now, "erp_pctile_1y": erp_pct, "src": "乐咕乐股"}
    try:
        aa = ak.stock_a_ttm_lyr().dropna(subset=["middlePETTM"])
        a_last = aa.iloc[-1]
        out["all_a_median_pe_ttm"] = round(float(a_last["middlePETTM"]), 2)
        out["all_a_pe_pctile_10y"] = round(float(a_last["quantileInRecent10YearsMiddlePeTtm"]), 4)
    except Exception as e:
        out["all_a_error"] = str(e)[:80]
    return out


PE = block("pe", pe_block) or {}
data["factors"]["pe"] = PE
time.sleep(1)

# =====================================================================
# 8. 市场：指数、波动率、成交额
# =====================================================================
def mkt_block():
    df = HS if HS is not None else get_hs()
    c = df["close"].astype(float)
    days = min(250, len(df))
    put("hs300", [dlab(x) for x in df["date"].tail(days)], c.tail(days),
        unit="", nd=2, keep=250)
    ma60 = c.rolling(60).mean()
    put("hs300_ma60", [dlab(x) for x in df["date"].tail(days)], ma60.tail(days),
        unit="", nd=2, keep=250)
    ret = c.pct_change()
    vol = ret.rolling(60).std() * np.sqrt(252) * 100
    put("vol60", [dlab(x) for x in df["date"].tail(days)], vol.tail(days),
        unit="%", freq="D", keep=250)
    v60 = float(vol.iloc[-1])
    return {"date": dlab(df.iloc[-1]["date"]),
            "hs300_close": round(float(c.iloc[-1]), 2),
            "mom_12_1_pct": round((c.iloc[-22] / c.iloc[-273] - 1) * 100, 1) if len(c) > 273 else None,
            "chg_20d_pct": round((c.iloc[-1] / c.iloc[-21] - 1) * 100, 1),
            "vol60_ann_pct": round(v60, 1),
            "vol60_pctile_1y": pctile(vol.tail(250), v60)}


MKT = block("mkt", mkt_block) or {}
data["factors"]["mkt"] = MKT
time.sleep(1)


def turnover_block():
    # 成交额直接用东财「成交额」字段（单位：元）。
    # 旧版用腾讯日线的 amount 字段，那是成交量（手），换算出的「亿元」口径不准，且当天不更新。
    sh = em_index("000001")[["date", "amount"]]
    sz = em_index("399001")[["date", "amount"]]
    m = pd.merge(sh, sz, on="date", suffixes=("_sh", "_sz"))
    m = m.dropna().sort_values("date").reset_index(drop=True)
    amt = (m["amount_sh"].astype(float) + m["amount_sz"].astype(float)) / 1e8
    ma20 = amt.rolling(20).mean()
    # 换手集中度：沪深 300 成交额占两市比重（大盘拥挤 / 抱团程度代理）
    h3 = em_index("000300")[["date", "amount"]]
    h3["a3"] = h3["amount"].astype(float) / 1e8
    a3 = h3.set_index("date")["a3"].reindex(m["date"]).ffill()
    conc = pd.Series(a3.values / amt.values * 100, index=m.index).dropna()
    tailc = conc.tail(250)
    put("concentration", [dlab(m["date"].iloc[i]) for i in tailc.index],
        tailc, unit="%", nd=1, freq="D", keep=250)
    conc_now = float(conc.iloc[-1]) if len(conc) else None
    conc_pct = pctile(conc.tail(750), conc_now) if conc_now is not None else None
    days = min(250, len(m))
    put("amount", [dlab(x) for x in m["date"].tail(days)], amt.tail(days),
        unit="亿元", nd=0, freq="D", keep=250)
    put("amount_ma20", [dlab(x) for x in m["date"].tail(days)], ma20.tail(days),
        unit="亿元", nd=0, freq="D", keep=250)
    return {"date": dlab(m.iloc[-1]["date"]),
            "amount_yi": round(float(amt.iloc[-1]), 0),
            "ma20_yi": round(float(ma20.iloc[-1]), 0),
            "ma20_pctile_3y": pctile(amt.tail(750), float(ma20.iloc[-1])),
            "conc_pct": round(conc_now, 1) if conc_now is not None else None,
            "conc_pctile_3y": conc_pct,
            "src": "东方财富 / 中证指数"}


TO = block("turnover", turnover_block) or {}
data["factors"]["turnover"] = TO

# =====================================================================
# 9. 因子计算
# =====================================================================
f = data["factors"]


def find(list_, kw):
    for x in list_:
        if kw in str(x.get("name", "")):
            return x
    return {}


pmi = find(data["dims"]["growth"]["official"], "PMI")
iav = find(data["dims"]["growth"]["official"], "工业增加值")
cpi = find(data["dims"]["inflation"]["official"], "CPI")
ppi = find(data["dims"]["inflation"]["official"], "PPI")
m2it = find(data["dims"]["liquidity"]["official"], "M1")
crd = find(data["dims"]["liquidity"]["official"], "新增人民币贷款")
usd = find(data["dims"]["external"]["highfreq"], "USD")
usr = find(data["dims"]["external"]["highfreq"], "美债")

# =====================================================================
# 8.5 派生：剩余流动性序列、四象限历史轨迹、维度状态
# =====================================================================

def ser_map(key):
    s_ = SER.get(key)
    if not s_:
        return {}
    return {p[0]: float(p[1]) for p in s_["points"]}


# ---- 剩余流动性 ①：M1 同比 − PPI 同比 ----
m1m, ppim = ser_map("m1"), ser_map("ppi")
common_m = sorted(set(m1m) & set(ppim))
surplus_series = {}
if len(common_m) >= 12:
    surplus_series = {k: round(m1m[k] - ppim[k], 1) for k in common_m}
    put("surplus_m1ppi", common_m, [surplus_series[k] for k in common_m],
        unit="pct", nd=1, freq="M", keep=60)

# ---- 剩余流动性 ②：M2 同比 − 名义 GDP 同比 ----
gdp_series, gdp_now = {}, None
try:
    g = ak.macro_china_gdp()
    g = g.copy()
    tok = g["季度"].astype(str).str.extract(r"(\d{4})年第(.+?季度)")
    g["_y"] = tok[0].astype(int)
    g["_t"] = tok[1]
    m_end = {"1季度": 3, "1-2季度": 6, "1-3季度": 9, "1-4季度": 12}
    g["_m"] = g["_t"].map(m_end)
    g = g.dropna(subset=["_m"]).sort_values(["_y", "_m"])
    g["_v"] = g["国内生产总值-绝对值"].astype(float)
    g["_prev"] = g.groupby("_t")["_v"].shift(1)
    g["_nom"] = (g["_v"] / g["_prev"] - 1) * 100
    gg = g.dropna(subset=["_nom"])
    for _, row in gg.tail(16).iterrows():
        key = f"{int(row['_y'])}-{int(row['_m']):02d}"
        gdp_series[key] = round(float(row["_nom"]), 1)
    if not gdp_series:
        data["errors"].append({"gdp": "名义 GDP 同比序列为空，季度标签未匹配"})
    if gdp_series:
        ks = sorted(gdp_series)
        put("gdp_nom", ks, [gdp_series[k] for k in ks], unit="%", nd=1, freq="Q", keep=16)
        gdp_now = gdp_series[ks[-1]]
except Exception as e:
    data["errors"].append({"gdp": f"{type(e).__name__}: {str(e)[:70]}"})

m2m = ser_map("m2")
surplus_gdp_now, surplus_gdp_prev = None, None
if gdp_series and m2m:
    ks = sorted(gdp_series)
    months = sorted(m2m)
    vals = []
    for mo in months:
        cand = [k for k in ks if k <= mo]
        if not cand:
            continue
        vals.append(round(m2m[mo] - gdp_series[cand[-1]], 1))
    mos_ok = months[-len(vals):] if vals else []
    if len(vals) >= 12:
        put("surplus_m2gdp", mos_ok, vals, unit="pct", nd=1, freq="M", keep=60)
        surplus_gdp_now = vals[-1]
        surplus_gdp_prev = vals[-2] if len(vals) > 1 else None

# ---- 四象限历史轨迹（增长 / 通胀 标准化 z 分数）----
def zscores(d, win=36):
    if len(d) < 14:
        return {}
    ks = sorted(d)
    idx = pd.to_datetime([k + "-01" if len(k) == 7 else k for k in ks])
    ser = pd.Series([d[k] for k in ks], index=idx)
    mu = ser.rolling(win, min_periods=12).mean()
    sd = ser.rolling(win, min_periods=12).std()
    z = (ser - mu) / sd
    return {k: round(float(v), 2) for k, v in zip(ks, z.values) if not pd.isna(v)}


def blend(*maps):
    maps = [m for m in maps if m]
    if not maps:
        return {}
    keys = set(maps[0])
    for m in maps[1:]:
        keys &= set(m)
    keys = sorted(keys)
    if not keys:
        return {}
    return {k: round(sum(m[k] for m in maps) / len(maps), 2) for k in keys}


g_z = blend(zscores(ser_map("pmi")), zscores(ser_map("iav")))
i_z = blend(zscores(ser_map("cpi")), zscores(ser_map("ppi")))
quad_path = []
if g_z and i_z:
    ks = sorted(set(g_z) & set(i_z))[-36:]
    if ks:
        put("quad_g", ks, [g_z[k] for k in ks], unit="", nd=2, freq="M", keep=36)
        put("quad_i", ks, [i_z[k] for k in ks], unit="", nd=2, freq="M", keep=36)
        quad_path = [{"d": k, "g": g_z[k], "i": i_z[k]} for k in ks]

# ---- 六个维度的状态标签（供顶部总览条使用）----
def dim_state(key, label, note, tone):
    data["dims"].setdefault(key, {})["state"] = {"label": label, "note": note, "tone": tone}

_pv = pmi.get("value"); _pm = pmi.get("mom")
if _pv is not None:
    if _pv >= 50 and (_pm or 0) > 0:
        dim_state("growth", "扩张加速", f"PMI {_pv}，环比 {_pm}", "pos")
    elif _pv >= 50:
        dim_state("growth", "扩张放缓", f"PMI {_pv}，环比 {_pm}", "mid")
    elif (_pm or 0) >= 0:
        dim_state("growth", "收缩改善", f"PMI {_pv}，环比 {_pm}", "mid")
    else:
        dim_state("growth", "收缩加深", f"PMI {_pv}，环比 {_pm}", "neg")

if ppi.get("value") is not None:
    _d = (ppi.get("value") or 0) - (ppi.get("prev") or 0)
    dim_state("inflation",
              "通胀上行" if _d > 0.05 else "通胀回落" if _d < -0.05 else "通胀走平",
              f"PPI {ppi.get('value')}%，CPI {cpi.get('value', '—')}%",
              "neg" if _d > 0.05 else "pos" if _d < -0.05 else "mid")

_sh = find(data["dims"]["liquidity"]["highfreq"], "隔夜")
_sc = m2it.get("scissors"); _scp = m2it.get("scissors_prev")
if _sc is not None:
    _w = (_sc - _scp) if _scp is not None else 0
    dim_state("liquidity",
              "资金活化" if _w > 0.2 else "活化放缓" if _w < -0.2 else "平稳",
              f"M1−M2 {_sc}pp，SHIBOR 隔夜 {_sh.get('value', '—')}%",
              "pos" if _w > 0.2 else "neg" if _w < -0.2 else "mid")

if fisc.get("cum_yoy") is not None:
    _fy = fisc["cum_yoy"]; _fyp = fisc.get("cum_yoy_prev")
    dim_state("fiscal",
              "收入改善" if (_fyp is not None and _fy > _fyp) else "收入放缓",
              f"财政收入累计同比 {_fy}%",
              "pos" if (_fyp is not None and _fy > _fyp) else "neg")

_cn = usr.get("cnus10") if usr else None
if _cn is not None:
    dim_state("external",
              "外部约束强" if _cn < -0.8 else "外部约束偏弱" if _cn < 0 else "外部压力小",
              f"中美利差 {_cn}pp，USD/CNY {usd.get('value', '—')}",
              "neg" if _cn < -0.8 else "mid" if _cn < 0 else "pos")

_lp = find(data["dims"]["policy"]["official"], "LPR")
if _lp.get("lpr1y") is not None:
    dim_state("policy", "政策观望" if not _lp.get("chg1") else "政策宽松",
              f"LPR 1Y {_lp.get('lpr1y')}%，5Y {_lp.get('lpr5y')}%",
              "mid" if not _lp.get("chg1") else "pos")


def growth_state(p):
    if p.get("value") is None:
        return None, "数据缺失"
    v, mom = p["value"], (p.get("mom") or 0)
    if v >= 50 and mom >= 0:
        return "up", "扩张加速"
    if v >= 50:
        return "slow", "扩张放缓"
    if mom >= 0:
        return "rec", "收缩改善"
    return "down", "收缩加深"


def infl_state(p):
    if p.get("value") is None:
        return None, "数据缺失"
    v, pv = p["value"], p.get("prev")
    if pv is None:
        return None, "数据缺失"
    rising = v >= pv
    if v > 0.5 and rising:
        return "up", "通胀上行"
    if v > 0.5:
        return "high", "通胀高位"
    if rising:
        return "rec", "通胀修复"
    return "down", "通胀低迷"


gs, gs_txt = growth_state(pmi)
is_, is_txt = infl_state(ppi)

QUAD = {
    ("up", "up"): ("过热", "顺周期资产优先：商品、周期股、短久期债券；警惕政策收紧对估值的压制"),
    ("up", "high"): ("过热", "商品与周期占优，逐步降低长久期暴露"),
    ("up", "rec"): ("复苏", "动量、周期、小盘风格占优；股票 > 商品 > 债券"),
    ("up", "down"): ("复苏初期", "股票优先（景气先行），关注政策加码方向；债券性价比下降"),
    ("slow", "up"): ("滞胀初期", "黄金、资源品、防御板块；减少高估值成长暴露"),
    ("slow", "high"): ("滞胀", "现金与抗通胀资产优先：黄金、能源、公用事业"),
    ("slow", "rec"): ("复苏验证期", "观察 PMI 能否重回扩张；均衡配置，保留债券底仓"),
    ("slow", "down"): ("弱平衡", "债券与红利防御占优，股票以结构性机会为主"),
    ("rec", "up"): ("复苏前夜", "左侧布局顺周期与政策受益方向；控制仓位"),
    ("rec", "high"): ("类滞胀", "防御为主：黄金、公用事业、短久期"),
    ("rec", "rec"): ("磨底", "哑铃策略：债券 + 红利为底，小仓位搏政策催化"),
    ("rec", "down"): ("衰退后期", "长久期债券、低波 / 质量因子；等待盈利见底信号"),
    ("down", "up"): ("滞胀", "抗通胀资产：黄金、能源；回避长久期债券与成长股"),
    ("down", "high"): ("滞胀", "防御优先，降低风险敞口"),
    ("down", "rec"): ("衰退", "低波、质量、长久期债；股票降仓，关注政策对冲"),
    ("down", "down"): ("衰退", "债券 > 现金 > 黄金 > 股票；动量策略失效风险高"),
}
quad_name, quad_advice = QUAD.get((gs, is_), ("待定", "宏观数据不足，维持均衡配置并跟踪"))

f["quadrant"] = {
    "growth_state": gs, "growth_txt": gs_txt,
    "infl_state": is_, "infl_txt": is_txt,
    "quadrant": quad_name, "advice": quad_advice,
    "logic": [
        f"增长判定：PMI {pmi.get('value', '缺失')}（荣枯线{'上' if (pmi.get('value') or 0) >= 50 else '下'}，"
        f"环比 {pmi.get('mom', '缺失')}）→ {gs_txt}",
        f"通胀判定：PPI 同比 {ppi.get('value', '缺失')}%，前值 {ppi.get('prev', '缺失')}% → {is_txt}",
        f"象限规则：增长({gs}) × 通胀({is_}) → 「{quad_name}」",
    ],
}

# ---- 流动性映射 ----
sc_chg = None
if m2it.get("scissors") is not None and m2it.get("scissors_prev") is not None:
    sc_chg = round(m2it["scissors"] - m2it["scissors_prev"], 1)
surplus = None
if m2it.get("m1") is not None and ppi.get("value") is not None:
    surplus = round(m2it["m1"] - ppi["value"], 1)

pe_pct = PE.get("all_a_pe_pctile_10y")
f["liq_map"] = {
    "scissors": m2it.get("scissors"), "scissors_chg": sc_chg,
    "m1": m2it.get("m1"), "m2": m2it.get("m2"),
    "surplus_m1_ppi": surplus,
    "surplus_m2_gdp": surplus_gdp_now,
    "surplus_m2_gdp_prev": surplus_gdp_prev,
    "gdp_nom": gdp_now,
    "all_a_pe_pctile_10y": pe_pct,
    "read": ("剪刀差走阔、剩余流动性改善，历史上对应全 A 估值中枢上移"
             + (f"；当前全 A 中位 PE 处于近 10 年 {round(pe_pct * 100)}% 分位" if pe_pct is not None else "")
             if (sc_chg is not None and sc_chg >= 0) else
             "剪刀差收窄、资金活化放缓，对估值中枢的支撑减弱；关注剩余流动性拐点"),
    "logic": [
        f"M1−M2 剪刀差 = {m2it.get('scissors', '缺失')}%（上月 {m2it.get('scissors_prev', '缺失')}%，变动 {sc_chg}）",
        f"剩余流动性①（M1 − PPI）= {surplus}；②（M2 − 名义 GDP）= {surplus_gdp_now}",
        f"名义 GDP 同比 = {gdp_now}%（国家统计局，季度）",
        f"全 A 中位 PE(TTM) 近 10 年分位 = {pe_pct if pe_pct is not None else '缺失'}",
        "映射规则：剪刀差与剩余流动性同向上行 → 权益估值环境友好；背离时以剩余流动性为准",
    ],
}

# ---- 信用 ----
cy = crd.get("cum_yoy")
sp_pct = Y.get("credit_spread_pctile_1y")
sp_txt = (f"信用利差处于近一年 {round(sp_pct * 100)}% 分位" if sp_pct is not None else "信用利差待接入")
if cy is not None and cy < 0:
    credit_read = f"贷款累计同比 {cy}%，实体融资需求偏弱；{sp_txt}，配置以利率债与高等级信用债为主，权益端等待信用脉冲回正。"
else:
    credit_read = f"贷款累计同比 {cy}%，信用处于扩张区间；{sp_txt}，风险偏好修复环境下可适度下沉，顺周期与金融板块受益。"
f["credit"] = {
    "t12m_yoy": None,
    "loan_inc": crd.get("value"), "loan_cum_yoy": cy,
    "spread_3y": Y.get("credit_spread_3y"),
    "spread_pctile_1y": Y.get("credit_spread_pctile_1y"),
    "read": credit_read,
    "logic": [
        f"新增人民币贷款 = {crd.get('value', '缺失')} 亿元（前值 {crd.get('prev', '缺失')}），累计同比 {crd.get('cum_yoy', '缺失')}%",
        f"3Y 中短票(AAA)−国债利差 = {Y.get('credit_spread_3y', '缺失')}%，近 1 年分位 {Y.get('credit_spread_pctile_1y', '缺失')}",
        "口径说明：akshare 社融接口当前不可用，以「新增人民币贷款」作为社融主项代理",
    ],
}

# ---- 风险情绪 ----
f["risk"] = {
    "hs300_pe_ttm": PE.get("hs300_pe_ttm"), "y10": Y.get("y10"),
    "erp": PE.get("erp"), "erp_pctile_1y": PE.get("erp_pctile_1y"),
    "read": ("ERP 处于高位：股票相对债券性价比突出（情绪偏悲观）" if (PE.get("erp_pctile_1y") or .5) > .7 else
             "ERP 处于低位：股票性价比一般，警惕拥挤" if (PE.get("erp_pctile_1y") or .5) < .3 else
             "ERP 处于中性区间"),
    "logic": [
        f"沪深 300 PE(TTM) = {PE.get('hs300_pe_ttm', '缺失')}，10Y 国债 = {Y.get('y10', '缺失')}%",
        f"ERP = 1/PE − 10Y = {PE.get('erp', '缺失')}%，近 1 年分位 {PE.get('erp_pctile_1y', '缺失')}",
    ],
}

# ---- 期限结构 ----
f["term"] = {
    "slope_10_1": Y.get("slope_10_1"), "slope_30_10": Y.get("slope_30_10"),
    "y10": Y.get("y10"), "y10_pctile_1y": Y.get("y10_pctile_1y"),
    "y10_chg_1m": Y.get("y10_chg_1m"),
    "read": ("曲线走陡：复苏交易或财政发力预期；利好银行息差与顺周期" if
             (Y.get("slope_10_1") is not None and Y.get("y10_chg_1m") is not None
              and Y["slope_10_1"] > 0.6 and Y["y10_chg_1m"] > 0) else
             "曲线平坦化：增长预期偏弱，债券牛市延续概率大"),
    "logic": [
        f"10Y−1Y 利差 = {Y.get('slope_10_1', '缺失')}%；30Y−10Y = {Y.get('slope_30_10', '缺失')}%",
        f"10Y 国债 {Y.get('y10', '缺失')}%（近 1 年分位 {Y.get('y10_pctile_1y', '缺失')}，近 1 月变动 {Y.get('y10_chg_1m', '缺失')}）",
    ],
}

# ---- 拥挤度 ----
to_pct = TO.get("ma20_pctile_3y")
vol_pct = MKT.get("vol60_pctile_1y")
crowd = None
if to_pct is not None and vol_pct is not None:
    crowd = round(to_pct * 60 + vol_pct * 40, 1)
elif to_pct is not None:
    crowd = round(to_pct * 100, 1)
f["crowd"] = {
    "conc_pct": TO.get("conc_pct"),
    "conc_pctile_3y": TO.get("conc_pctile_3y"),
    "score": crowd,
    "tier": ("拥挤" if (crowd or 0) >= 70 else "中性偏热" if (crowd or 0) >= 55 else
             "中性" if (crowd or 0) >= 40 else "冷清"),
    "turnover_pctile_3y": to_pct, "vol_pctile_1y": vol_pct,
    "read": ("拥挤度偏高：动量策略崩溃风险上升，追高风险大；新仓位等待回踩或缩量确认" if (crowd or 0) >= 70 else
             "拥挤度中性：动量环境可维持，按趋势跟踪纪律执行"),
    "logic": [
        f"成交额 MA20 三年分位 = {to_pct}（{TO.get('ma20_yi', '缺失')} 亿元）",
        f"沪深 300 60 日年化波动率一年分位 = {vol_pct}（{MKT.get('vol60_ann_pct', '缺失')}%）",
        f"沪深 300 成交额占比 = {TO.get('conc_pct', '缺失')}%（三年分位 {TO.get('conc_pctile_3y', '缺失')}）",
        "合成规则：成交额分位 60% + 波动率分位 40%；集中度作为二阶确认，占比抬升说明抱团加剧",
    ],
}

# ---- AQR 式四因子（代理构造）----
aqr = {}
if PE.get("erp_pctile_1y") is not None:
    v = PE["erp_pctile_1y"]
    aqr["value"] = {"name": "Value", "full": "估值偏离",
                    "proxy": "沪深 300 ERP 一年分位", "value": round(v * 100), "unit": "分位",
                    "signal": "便宜" if v > .7 else "贵" if v < .3 else "中性"}
if MKT.get("mom_12_1_pct") is not None:
    m = MKT["mom_12_1_pct"]
    aqr["momentum"] = {"name": "Momentum", "full": "时序动量",
                       "proxy": "沪深 300 12−1 月动量", "value": m, "unit": "%",
                       "signal": "正向" if m > 0 else "负向"}
if Y.get("slope_10_1") is not None:
    c = Y["slope_10_1"]
    aqr["carry"] = {"name": "Carry", "full": "套息",
                    "proxy": "国债 10Y−1Y 期限利差", "value": c, "unit": "%",
                    "signal": "套息空间足" if c > .5 else "套息空间薄"}
if vol_pct is not None and crowd is not None:
    d = (1 - vol_pct) * 60 + (1 - crowd / 100) * 40
    aqr["defensive"] = {"name": "Defensive", "full": "防御",
                        "proxy": "低波动分位×60% + (1−拥挤度)×40%",
                        "value": round(d, 1), "unit": "分位",
                        "signal": "防御价值低（市况稳）" if d > 60 else "防御价值高（市况险）" if d < 40 else "中性"}
f["aqr"] = aqr


# ---- 宏观因子总表 ----
def smart_yi(v):
    if v is None:
        return "—"
    return f"{v:,.0f} 亿元"


def g(d, k, suf=""):
    v = d.get(k)
    if v is None:
        return "待接入"
    if isinstance(v, (int, float)):
        v = f"{v:,.0f}" if abs(v) >= 1000 else v
    return f"{v}{suf}"


f["factor_table"] = [
    {"factor": "增长", "construct": "PMI / 工业增加值同比、全球 PMI", "assets": "股票、商品、周期股",
     "reading": f"PMI {g(pmi, 'value')}（{gs_txt}）；工业增加值同比 {g(iav, 'value', '%')}"},
    {"factor": "通胀", "construct": "CPI / PPI 超预期幅度、盈亏平衡通胀", "assets": "债券久期、黄金",
     "reading": f"CPI 同比 {g(cpi, 'value', '%')}；PPI 同比 {g(ppi, 'value', '%')}（{is_txt}）"},
    {"factor": "利率与流动性", "construct": "政策利率变动、短端利率偏离度", "assets": "债券、成长股估值",
     "reading": f"SHIBOR 隔夜 {g(find(data['dims']['liquidity']['highfreq'], '隔夜'), 'value', '%')}；"
                f"LPR 1Y {g(find(data['dims']['policy']['official'], 'LPR'), 'lpr1y', '%')}；"
                f"M1−M2 {g(m2it, 'scissors')}"},
    {"factor": "信用", "construct": "信用利差、社融 / 贷款增速", "assets": "信用债、风险资产",
     "reading": f"新增贷款 {g(crd, 'value', ' 亿元')}；3Y AAA 利差 {g(Y, 'credit_spread_3y', '%')}"},
    {"factor": "汇率", "construct": "美元指数、实际有效汇率、中美利差", "assets": "新兴市场、出口链",
     "reading": f"USD/CNY {g(usd, 'value')}；美债 10Y {g(usr, 'us10y', '%')}；中美利差 {g(usr, 'cnus10')}"},
    {"factor": "风险情绪", "construct": "ERP = 1/PE − 10Y 国债、VIX", "assets": "全资产 Beta",
     "reading": f"ERP {g(PE, 'erp', '%')}；VIX 待接入"},
    {"factor": "期限结构", "construct": "利率主成分：水平 / 斜率 / 曲率", "assets": "债券组合配置",
     "reading": f"10Y−1Y {g(Y, 'slope_10_1', '%')}；10Y 水平 {g(Y, 'y10', '%')}"},
]

# =====================================================================
# 9.5 v2 新增通道（宏观量化看板）
# 每个通道只服务一个用途，字段名与 macro_v2.py 对齐：
#   sf_inc      社融增量（月）      → 政策强度指数「社融脉冲」
#   fai_yoy     固投同比（月）      → 成长/价值 9 信号之一
#   margin_bal  两融融资余额（日）  → 仓位卡季节方向确认 + 风格资金流信号
#   big_flow_pct 超大单净流入占比（日）→ 风格资金流信号
#   div_yield   上证 A 股股息率（日）→ 风格「股息比」信号
#   gold_fut    沪金主连（日）      → 趋势保护
#   tr_*        四类资产月线        → 趋势保护（月频双均线/MACD/布林）
#   industry    申万一级 31 行业    → 模块 5 事件库 / 拥挤度 / 生命周期
# =====================================================================


def sf_block():
    """社会融资规模增量。来源：央行，月频，按月发布（通常次月 10-15 日）。"""
    df = ak.macro_china_shrzgm()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "社会融资规模增量"]).sort_values("_d")
    put("sf_inc", [mlab(x) for x in df["_d"]], df["社会融资规模增量"],
        unit="亿元", freq="M", nd=0, keep=84)
    last = df.iloc[-1]
    return {"name": "社会融资规模增量", "date": mlab(last["_d"]),
            "value": round(float(last["社会融资规模增量"]), 0), "unit": "亿元",
            "src": "中国人民银行"}


def fai_block():
    """固定资产投资完成额同比。来源：统计局，月频。"""
    df = ak.macro_china_gdzctz()
    df["_d"] = df["月份"].map(parse_cn)
    df = df.dropna(subset=["_d", "同比增长"]).sort_values("_d")
    put("fai_yoy", [mlab(x) for x in df["_d"]], df["同比增长"],
        unit="%", freq="M", keep=84)
    last = df.iloc[-1]
    return {"name": "固定资产投资同比", "date": mlab(last["_d"]),
            "value": round(float(last["同比增长"]), 1), "unit": "%",
            "src": "国家统计局"}


def margin_block():
    """上交所融资余额（两融）。来源：上交所，日频，T+1 发布。"""
    start = (TODAY - timedelta(days=800)).strftime("%Y%m%d")
    df = ak.stock_margin_sse(start_date=start, end_date=TODAY.strftime("%Y%m%d"))
    df["_d"] = pd.to_datetime(df["信用交易日期"].astype(str), format="%Y%m%d", errors="coerce")
    df = df.dropna(subset=["_d"]).sort_values("_d")
    v = df["融资余额"].astype(float) / 1e8
    put("margin_bal", [dlab(x) for x in df["_d"]], v, unit="亿元", nd=0, freq="D", keep=520)
    return {"name": "融资余额（沪市）", "date": dlab(df.iloc[-1]["_d"]),
            "value": round(float(v.iloc[-1]), 0), "unit": "亿元", "src": "上海证券交易所"}


def flow_block():
    """全市场资金流：超大单净流入净占比。来源：东方财富，日频。"""
    df = ak.stock_market_fund_flow()
    df["_d"] = pd.to_datetime(df["日期"])
    df = df.sort_values("_d")
    col = "超大单净流入-净占比"
    put("big_flow_pct", [dlab(x) for x in df["_d"]], df[col],
        unit="%", nd=2, freq="D", keep=520)
    last = df.iloc[-1]
    return {"name": "超大单净流入占比", "date": dlab(last["_d"]),
            "value": round(float(last[col]), 2), "unit": "%", "src": "东方财富"}


def div_block():
    """上证 A 股整体股息率。来源：乐咕乐股，日频。"""
    df = ak.stock_a_gxl_lg(symbol="上证A股")
    df["_d"] = pd.to_datetime(df["日期"])
    df = df.sort_values("_d")
    put("div_yield", [dlab(x) for x in df["_d"]], df["股息率"],
        unit="%", nd=2, freq="D", keep=520)
    last = df.iloc[-1]
    return {"name": "上证 A 股股息率", "date": dlab(last["_d"]),
            "value": round(float(last["股息率"]), 2), "unit": "%", "src": "乐咕乐股"}


def gold_fut_block():
    """沪金主连。来源：新浪期货 futures_zh_daily_sina（2008 年至今，比 futures_main_sina 的窗口长）。
    日频序列只留近两年，月线留 90 个月供趋势保护使用。"""
    df = ak.futures_zh_daily_sina(symbol="AU0")
    df["_d"] = pd.to_datetime(df["date"])
    df = df.sort_values("_d")
    put("gold_fut", [dlab(x) for x in df["_d"]], df["close"],
        unit=" 元/克", nd=2, freq="D", keep=520)
    # 同时压一份月线，供趋势保护使用（需要 30 个月以上）
    ks, vs = _monthly_last([dlab(x) for x in df["_d"]], df["close"])
    put("tr_gold", ks, vs, unit=" 元/克", nd=2, freq="M", keep=90)
    last = df.iloc[-1]
    return {"name": "沪金主连", "date": dlab(last["_d"]),
            "value": round(float(last["close"]), 2), "unit": " 元/克", "src": "上海期货交易所"}


def _monthly_last(labels, values):
    """把日频序列压成月线（每月取最后一个有效值），用于月频趋势判定。"""
    m = {}
    for a, b in zip(labels, values):
        try:
            fb = float(b)
        except Exception:
            continue
        if pd.isna(fb):
            continue
        m[str(a)[:7]] = fb
    ks = sorted(m)
    return ks, [m[k] for k in ks]


def shibor_monthly_block():
    """7 天 SHIBOR 月均值。仅用于政策强度指数的「货币价格」分项（需要 3 年以上历史）。"""
    df = ak.rate_interbank(market="上海银行同业拆借市场", symbol="Shibor人民币", indicator="1周")
    df["_d"] = pd.to_datetime(df["报告日"])
    df = df.dropna(subset=["利率"]).sort_values("_d")
    ks, vs = [], []
    for m, g in df.groupby(df["_d"].dt.strftime("%Y-%m")):
        ks.append(m)
        vs.append(float(g["利率"].astype(float).mean()))
    put("shibor_7d_m", ks, vs, unit="%", nd=3, freq="M", keep=84)
    return {"name": "7 天 SHIBOR 月均", "date": ks[-1], "value": round(vs[-1], 3),
            "unit": "%", "src": "全国银行间同业拆借中心"}


def trend_block():
    """四类资产月线：A股（沪深 300）、利率债（10Y 国债取负作价格代理）、商品（原油）、黄金（沪金）。"""
    out = {}
    # A 股：趋势判定要 30 个月以上月线，日线窗口要比看板序列更长
    try:
        long_hs = HS if (HS is not None and len(HS) > 900) else em_index("000300", 2600)
        ks, vs = _monthly_last([dlab(x) for x in long_hs["date"]], long_hs["close"])
        put("tr_hs300", ks, vs, unit="", nd=2, freq="M", keep=90)
        out["hs300"] = len(ks)
    except Exception as e:
        data["errors"].append({"trend_hs300": f"{type(e).__name__}: {str(e)[:100]}"})
    # 利率债：中债 10Y 收益率取负
    try:
        b = ak.bond_zh_us_rate(start_date="20180101")
        b = b.dropna(subset=["中国国债收益率10年"])
        ks, vs = _monthly_last([dlab(x) for x in pd.to_datetime(b["日期"])],
                               -b["中国国债收益率10年"].astype(float))
        put("tr_bond", ks, vs, unit="", nd=3, freq="M", keep=90)
        out["bond"] = len(ks)
    except Exception as e:
        data["errors"].append({"trend_bond": f"{type(e).__name__}: {str(e)[:100]}"})
    # 商品：INE 原油主连
    try:
        df = ak.futures_main_sina(symbol="SC0",
                                  start_date=(TODAY - timedelta(days=2000)).strftime("%Y%m%d"),
                                  end_date=TODAY.strftime("%Y%m%d"))
        ks, vs = _monthly_last([dlab(x) for x in pd.to_datetime(df["日期"])], df["收盘价"])
        put("tr_sc", ks, vs, unit=" 元/桶", nd=1, freq="M", keep=90)
        out["sc"] = len(ks)
    except Exception as e:
        data["errors"].append({"trend_sc": f"{type(e).__name__}: {str(e)[:100]}"})
    # 黄金：黄金月线已由 gold_fut_block 用 futures_zh_daily_sina（2008 年至今）产出，
    # 这里只做兜底——若上游没取到长月线，才退回用 gold_fut 的日线聚合（窗口短，趋势保护会判不可用）
    cur = SER.get("tr_gold", {}).get("points") or []
    if len(cur) >= 40:
        out["gold"] = len(cur)
    else:
        pts = SER.get("gold_fut", {}).get("points") or []
        if pts:
            ks, vs = _monthly_last([p[0] for p in pts], [p[1] for p in pts])
            put("tr_gold", ks, vs, unit=" 元/克", nd=2, freq="M", keep=90)
            out["gold"] = len(ks)
    return out


# ---- 申万一级行业：事件库 / 拥挤度 / 生命周期 ----
def _fwd_ret(close, n=20):
    """事件后 n 日收益，末尾补 NaN 保持长度对齐。"""
    c = np.asarray(close, dtype=float)
    fwd = np.full(len(c), np.nan)
    if len(c) > n:
        fwd[:-n] = c[n:] / c[:-n] - 1
    return fwd


def _event_stats(mask, fwd, min_n=8):
    m = np.asarray(mask, dtype=bool) & ~np.isnan(fwd)
    n = int(m.sum())
    if n < 3:
        return None
    r = fwd[m]
    sd = float(np.std(r))
    # IR 按年化口径：事件后 20 日收益均值 / 标准差 × √(252/20)，与卖方事件库量级可比
    ir = float(np.mean(r) / sd * np.sqrt(252 / 20)) if sd else None
    win = float((r > 0).mean())
    return {"n": n, "ir": round(ir, 2) if ir is not None else None,
            "win": round(win, 3), "avg": round(float(np.mean(r)) * 100, 2)}


def industry_block():
    """申万一级行业（现行 31 个）：近 3 年日线 → 触发事件、IR、拥挤度、生命周期标签。

    事件口径（8 种模式，参照广发事件库的四类写法）：
      历史高低点：创 250 日新高 / 新低
      均值±2σ：上破 / 下破 60 日均值 2 倍标准差
      连续涨跌：连涨 5 日 / 连跌 5 日
      涨后跌 / 跌后涨：5 日累计涨(跌)超 4% 后当日反向超 1.5%
    IR 为事件后 20 日收益的均值/标准差（非年化）；按 IR≥0.7 且次数≥8 判为「有效事件」。
    """
    info = ak.sw_index_first_info()
    info["_code"] = info["行业代码"].astype(str).str.split(".").str[0]
    items, fails = [], []
    for _, row in info.iterrows():
        code, name = row["_code"], str(row["行业名称"])
        try:
            df = ak.index_hist_sw(symbol=code, period="day")
            df = df.sort_values("日期")
            close = pd.to_numeric(df["收盘"], errors="coerce")
            amt = pd.to_numeric(df["成交额"], errors="coerce")
            close = close.dropna()
            if len(close) < 300:
                fails.append(name)
                continue
            c = close.values.astype(float)
            a = amt.reindex(close.index).fillna(0).values.astype(float)
            s = pd.Series(c)
            ret = s.pct_change()
            ma60 = s.rolling(60).mean()
            sd60 = s.rolling(60).std()
            ma20a = pd.Series(a).rolling(20).mean()
            hi250 = s.rolling(250, min_periods=200).max()
            lo250 = s.rolling(250, min_periods=200).min()
            fwd = _fwd_ret(c, 20)

            pats = [
                ("创 250 日新高", "历史高低点", (c >= hi250.values)),
                ("创 250 日新低", "历史高低点", (c <= lo250.values)),
                ("上破 60 日均值 +2σ", "均值±2σ", (s > ma60 + 2 * sd60).values),
                ("下破 60 日均值 −2σ", "均值±2σ", (s < ma60 - 2 * sd60).values),
                ("连涨 5 日", "连续涨跌", ret.rolling(5).apply(lambda x: (x > 0).all(), raw=True).fillna(0).values > 0),
                ("连跌 5 日", "连续涨跌", ret.rolling(5).apply(lambda x: (x < 0).all(), raw=True).fillna(0).values > 0),
                ("涨后跌", "涨后跌",
                 ((s / s.shift(5) - 1 > 0.04) & (ret < -0.015)).fillna(False).values),
                ("跌后涨", "涨后跌",
                 ((s / s.shift(5) - 1 < -0.04) & (ret > 0.015)).fillna(False).values),
            ]
            trig, all_ev = [], []
            for label, group, mask in pats:
                st = _event_stats(mask, fwd)
                if not st:
                    continue
                effective = (st["ir"] is not None and st["ir"] >= 0.7 and st["n"] >= 8)
                ev = {"name": label, "group": group, "ir": st["ir"], "n": st["n"],
                      "win": st["win"], "avg": st["avg"], "effective": effective}
                all_ev.append(ev)
                if bool(np.asarray(mask)[-1]):
                    trig.append(dict(ev, date=dlab(df.iloc[-1]["日期"])))

            heat = pctile(ma20a.tail(760), float(ma20a.iloc[-1])) if not pd.isna(ma20a.iloc[-1]) else None
            price_pct = pctile(c[-760:], c[-1])
            mom20 = (c[-1] / c[-21] - 1) * 100 if len(c) > 21 else None
            mom60 = (c[-1] / c[-61] - 1) * 100 if len(c) > 61 else None

            if heat is not None and heat > 0.9:
                lab, why = "高拥挤筑顶", f"成交热度 {round(heat * 100)}% 分位（>90%）"
            elif mom20 is not None and mom20 < -8:
                lab, why = "超跌反弹", f"近 20 日 {mom20:.1f}%（<-8%）且未触发高拥挤"
            elif price_pct is not None and price_pct < 0.2 and (mom20 or 0) > 0:
                lab, why = "困境反转", f"价格分位 {round(price_pct * 100)}%（<20%）且 20 日动量转正"
            elif mom60 is not None and mom60 > 0:
                lab, why = "趋势跟踪", f"60 日动量 {mom60:+.1f}%，未触发其他条件"
            else:
                lab, why = "弱势整理", f"20 日 {(mom20 or 0):+.1f}%、60 日 {(mom60 or 0):+.1f}%，均未转正"

            eff = [e for e in trig if e["effective"]]
            items.append({
                "code": code, "name": name, "close": round(float(c[-1]), 2),
                "mom20": None if mom20 is None else round(mom20, 1),
                "mom60": None if mom60 is None else round(mom60, 1),
                "heat_pct": heat, "price_pctile": price_pct,
                "pe": None if pd.isna(row.get("TTM(滚动)市盈率")) else round(float(row["TTM(滚动)市盈率"]), 1),
                "pb": None if pd.isna(row.get("市净率")) else round(float(row["市净率"]), 2),
                "div": None if pd.isna(row.get("静态股息率")) else round(float(row["静态股息率"]), 2),
                "label": lab, "label_why": why,
                "triggered": bool(eff), "events": trig,
                "best_ir": max([e["ir"] for e in eff], default=None),
            })
        except Exception as e:
            fails.append(name)
            data["errors"].append({f"sw_{name}": f"{type(e).__name__}: {str(e)[:70]}"})
    if fails:
        print("[warn] 申万行业未取到：" + "、".join(fails[:8]))
    return {"available": bool(items), "asof": data.get("asof", {}).get("trade_date"),
            "items": items, "n": len(items),
            "note": "申万一级现行 31 个行业全量纳入；IR 为自算并年化（事件后 20 日收益均值/标准差 × √(252/20)）",
            "rule": "事件有效标准：IR ≥ 0.7 且历史触发次数 ≥ 8；拥挤度＝成交额 MA20 的近 3 年分位，>90% 判高拥挤",
            "missed": fails}


def rrr_block():
    """存款准备金率。来源：akshare macro_china_reserve_requirement_ratio（央行公告，事件驱动，
    有调整即新增一行，无调整不新增）。数据按公布时间倒序，需要按「生效时间」正序后取末值。
    产出：rrr_large 序列（历次调整台阶）+ 当前大型/中小型数值。"""
    df = ak.macro_china_reserve_requirement_ratio()
    df = df.dropna(subset=["大型金融机构-调整后"])

    def _d(s):
        m = re.match(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", str(s))
        return "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3))) if m else None

    rows = []
    for _, r in df.iterrows():
        k = _d(r["生效时间"])
        if not k:
            continue
        large = r["大型金融机构-调整后"]
        small = r["中小金融机构-调整后"]
        rows.append((k, float(large), float(small) if pd.notna(small) else None))
    if not rows:
        return None
    rows.sort()
    put("rrr_large", [x[0] for x in rows], [x[1] for x in rows],
        unit="%", freq="E", nd=2, keep=40)
    last = rows[-1]
    prev = rows[-2][1] if len(rows) > 1 else None
    return {"large": last[1], "small": last[2], "asof": last[0],
            "chg": round(last[1] - prev, 2) if prev is not None else None,
            "n": len(rows)}


v2_extra = {}
for _name, _fn in [("sf", sf_block), ("fai", fai_block), ("margin", margin_block),
                   ("flow", flow_block), ("div", div_block), ("gold_fut", gold_fut_block),
                   ("shibor_m", shibor_monthly_block), ("rrr", rrr_block)]:
    r = block("v2_" + _name, _fn)
    if r:
        v2_extra[_name] = r
    time.sleep(0.6)

trend_info = block("v2_trend", trend_block)
industry = block("v2_industry", industry_block)

# ---- macro_v2：三轴/卦限/库存/仓位/政策/因子/风格/趋势/ERP/行业 ----
try:
    import macro_v2
    data["macro_v2"] = macro_v2.build(SER, industry)
    if trend_info:
        data["macro_v2"]["trend_series"] = trend_info
except Exception as e:
    data["errors"].append({"macro_v2": f"{type(e).__name__}: {str(e)[:120]}"})
    data["macro_v2"] = {"available": False, "note": "计算层异常：" + str(e)[:80]}

# =====================================================================
# 9.7 政策工具箱：自动项 + 人工口径
#   自动项（存准率）由 rrr_block 抓取；其余为年度/事件性口径，放在仓库根目录
#   manual.json，由定时任务核验官方公告后更新。前端从 data.manual.items 取，
#   缺项回落到 config.js 里的「待人工更新」，不会出现空白或报错。
# =====================================================================
def manual_block(rrr):
    items, meta = {}, {}
    mf = os.path.join(BASE, "manual.json")
    if os.path.isfile(mf):
        try:
            with open(mf, encoding="utf-8") as f:
                mm = json.load(f)
            src = mm.get("items") or {}
            for k, val in src.items():
                if isinstance(val, dict) and val.get("v"):
                    items[k] = {"v": val["v"], "note": val.get("note", ""),
                                "asof": val.get("asof"), "src": val.get("src", "人工"),
                                "auto": False}
            meta = {"updated": mm.get("updated"), "source": mm.get("source")}
        except Exception as e:
            data["errors"].append({"manual.json": f"{type(e).__name__}: {str(e)[:90]}"})
    if rrr:
        extra = ("，较上次 %+.2fpp" % rrr["chg"]) if rrr.get("chg") is not None else ""
        items["rrr"] = {
            "v": "%.2f%% / %.2f%%" % (rrr["large"], rrr["small"]),
            "note": "大型 / 中小型金融机构，%s 生效%s" % (rrr["asof"], extra),
            "asof": rrr["asof"], "src": "央行公告（自动抓取）", "auto": True}
    return {"available": bool(items), "items": items,
            "updated": meta.get("updated"), "source": meta.get("source"),
            "note": "存准率为自动抓取；其余为年度/事件性人工口径，按官方公告更新"}


data["manual"] = manual_block((v2_extra or {}).get("rrr"))

# =====================================================================
# 10. 结论卡片
# =====================================================================
QADV = quad_advice

# 各卡片的结论语气（用于配色：pos=利好/偏多，neg=不利/偏空，mid=中性）
quad_tone = ("neg" if quad_name in ("滞胀", "滞胀初期", "衰退", "衰退后期", "类滞胀") else
             "pos" if quad_name in ("复苏", "复苏初期", "过热") else "mid")
liq_tone = "pos" if (sc_chg is not None and sc_chg >= 0) else "neg"
credit_tone = "pos" if (cy is not None and cy > 0) else "neg"
crowd_tone = "neg" if (crowd or 0) >= 70 else "pos" if (crowd or 0) < 40 else "mid"

aqr_best = max(aqr.items(), key=lambda kv: (kv[1].get("value") or 0) / (100 if kv[1].get("unit") == "分位" else 1)) if aqr else None

data["verdict"] = {
    "stance": quad_name,
    "tone": quad_tone,
    "headline": f"{quad_name}：增长{gs_txt}、{is_txt}，"
                + ("久期与成长先降、抗通胀实物资产先加" if quad_tone == "neg" else
                   "顺周期与动量风格可加、债券性价比下降" if quad_tone == "pos" else
                   "维持均衡，等待方向确认"),
    "advice": QADV + "。",
    "chips": [
        {"k": "宏观象限", "v": quad_name, "tone": quad_tone},
        {"k": "全 A 估值", "v": (f"近 10 年 {round(pe_pct * 100)}% 分位" if pe_pct is not None else "待接入"),
         "tone": ("pos" if (pe_pct or .5) < .35 else "neg" if (pe_pct or .5) > .75 else "mid")},
        {"k": "拥挤度", "v": f"{f['crowd']['tier']}（{crowd}）", "tone": crowd_tone},
        {"k": "信用", "v": ("扩张" if (cy or 0) > 0 else "收缩"), "tone": credit_tone},
    ],
}

data["cards"] = [
    {"id": "quad", "title": "宏观象限 → 风格因子择时", "badge": quad_name, "tone": quad_tone,
     "headline": f"{gs_txt} × {is_txt} → {quad_name}",
     "text": QADV + "。",
     "metrics": [
         {"k": "制造业 PMI", "v": f"{pmi.get('value', '—')}", "n": f"荣枯线下" if (pmi.get("value") or 50) < 50 else "荣枯线上"},
         {"k": "PPI 同比", "v": f"{ppi.get('value', '—')}%", "n": f"前值 {ppi.get('prev', '—')}%"},
         {"k": "增长 z 分数", "v": f"{quad_path[-1]['g']:+.2f}" if quad_path else "—", "n": "36 个月滚动标准化"},
         {"k": "通胀 z 分数", "v": f"{quad_path[-1]['i']:+.2f}" if quad_path else "—", "n": "36 个月滚动标准化"},
     ],
     "action": ("降久期、减成长与高估值动量，加黄金 / 能源 / 红利；" if quad_tone == "neg" else
                "加动量、周期与小盘，降债券久期；" if quad_tone == "pos" else "维持哑铃，等待方向"),
     "steps": f["quadrant"]["logic"] + [f"历史轨迹：近 36 个月增长 z 与通胀 z 沿 (增长, 通胀) 平面移动，当前落在 {quad_name} 区域"],
     "src": "国家统计局（PMI / PPI）"},

    {"id": "liq", "title": "流动性 → 估值中枢", "badge": "支撑" if liq_tone == "pos" else "压制", "tone": liq_tone,
     "headline": (f"剪刀差 {m2it.get('scissors', '—')}pp（环比 {sc_chg:+}）" if sc_chg is not None else "剪刀差待接入"),
     "text": f["liq_map"]["read"] + "。",
     "metrics": [
         {"k": "M1 − M2", "v": f"{m2it.get('scissors', '—')}pp", "n": f"M1 {m2it.get('m1', '—')}% / M2 {m2it.get('m2', '—')}%"},
         {"k": "剩余流动性 ①", "v": f"{surplus}", "n": "M1 − PPI"},
         {"k": "剩余流动性 ②", "v": f"{surplus_gdp_now}", "n": "M2 − 名义 GDP"},
         {"k": "全 A 中位 PE", "v": (f"{round(pe_pct * 100)}% 分位" if pe_pct is not None else "—"), "n": "近 10 年"},
     ],
     "action": ("剩余流动性为正且抬升 → 估值中枢有支撑，权益可给更高估值容忍度；" if (surplus_gdp_now or 0) > 0 else
                "剩余流动性转负 → 估值扩张受限，赚盈利的钱而非估值的钱；"),
     "steps": f["liq_map"]["logic"],
     "src": "中国人民银行（M1/M2）、国家统计局（GDP/PPI）"},

    {"id": "credit", "title": "信用环境 → 风险偏好", "badge": "扩张" if credit_tone == "pos" else "收缩", "tone": credit_tone,
     "headline": f"贷款累计同比 {cy}%",
     "text": f["credit"]["read"],
     "metrics": [
         {"k": "新增人民币贷款", "v": f"{smart_yi(crd.get('value'))}", "n": f"前值 {smart_yi(crd.get('prev'))}"},
         {"k": "累计同比", "v": f"{cy}%", "n": "贷款余额口径"},
         {"k": "3Y AAA 信用利差", "v": f"{Y.get('credit_spread_3y', '—')}%", "n": f"近 1 年 {round((sp_pct or 0) * 100)}% 分位"},
     ],
     "action": ("信用收缩 + 利差低位 → 以利率债与高等级信用债为底仓，权益端等信用脉冲回正再进攻；" if credit_tone == "neg" else
                "信用扩张 → 可适度信用下沉，顺周期与金融板块受益；"),
     "steps": f["credit"]["logic"],
     "src": "中国人民银行、中债估值"},

    {"id": "crowd", "title": "拥挤度 → 动量崩溃风险", "badge": f["crowd"]["tier"], "tone": crowd_tone,
     "headline": f"拥挤度 {crowd}（{f['crowd']['tier']}）",
     "text": f["crowd"]["read"] + "。",
     "metrics": [
         {"k": "成交额分位", "v": f"{round((to_pct or 0) * 100)}%", "n": f"MA20 {TO.get('ma20_yi', '—')} 亿元"},
         {"k": "波动率分位", "v": f"{round((vol_pct or 0) * 100)}%", "n": f"60 日年化 {MKT.get('vol60_ann_pct', '—')}%"},
         {"k": "成交集中度", "v": f"{TO.get('conc_pct', '—')}%", "n": "沪深 300 占两市成交"},
     ],
     "action": ("拥挤度低 → 趋势策略容错高，可按纪律持有动量仓位；" if crowd_tone == "pos" else
                "拥挤度高 → 动量策略崩溃概率上升，新仓等回踩或缩量确认；"),
     "steps": f["crowd"]["logic"],
     "src": "腾讯财经、中证指数"},

    {"id": "aqr", "title": "AQR 四因子 → 跨资产配置", "badge": (aqr_best[1].get("signal") if aqr_best else "待接入"),
     "tone": "mid",
     "headline": "Carry / Value / Momentum / Defensive 打分",
     "text": ("四因子中 " + aqr_best[0].title() + " 得分最高（" + str(aqr_best[1].get("value")) +
              (aqr_best[1].get("unit") or "") + "），" + str(aqr_best[1].get("signal")) + "。") if aqr_best else "因子待接入",
     "metrics": [
         {"k": "Value", "v": f"{aqr.get('value', {}).get('value', '—')}", "n": "ERP 一年分位"},
         {"k": "Momentum", "v": f"{aqr.get('momentum', {}).get('value', '—')}%", "n": "12−1 月动量"},
         {"k": "Carry", "v": f"{aqr.get('carry', {}).get('value', '—')}%", "n": "10Y−1Y 期限利差"},
         {"k": "Defensive", "v": f"{aqr.get('defensive', {}).get('value', '—')}", "n": "低波 × 低拥挤"},
     ],
     "action": ("Value 高分位 → 加估值便宜的资产；Momentum 负向 → 降趋势暴露；"
                "Carry 薄 → 套息交易性价比低；Defensive 高分位 → 防御价值低，可适度进攻；"),
     "steps": [
         f"Value：ERP 一年分位 = {aqr.get('value', {}).get('value', '—')}%（≥70 便宜，≤30 贵）",
         f"Momentum：沪深 300 12−1 月动量 = {aqr.get('momentum', {}).get('value', '—')}%",
         f"Carry：10Y−1Y = {aqr.get('carry', {}).get('value', '—')}%",
         f"Defensive = (1 − 波动率分位) × 60 + (1 − 拥挤度) × 40 = {aqr.get('defensive', {}).get('value', '—')}",
     ],
     "src": "中债估值、沪深 300（自建代理）"},
]

# =====================================================================
# 11. 交叉校验：拿中证指数官网的官方收盘价核对入库的沪深 300
# =====================================================================
def verify_csindex():
    """官方源是 T-1 更新，所以比对的是「最近共同交易日」，不是最新交易日。
    偏差超过 0.05% 说明我们入库的价格有问题，写进 checks 供 /api/status 暴露。"""
    try:
        start = (TODAY - timedelta(days=12)).strftime("%Y%m%d")
        url = ("https://www.csindex.com.cn/csindex-home/perf/index-perf"
               f"?indexCode=000300&startDate={start}&endDate={TODAY.strftime('%Y%m%d')}")
        rows = (json.loads(http_get(url, referer="https://www.csindex.com.cn/")) or {}).get("data") or []
        if not rows:
            return {"ok": None, "note": "中证官网未返回数据"}
        off = {r["tradeDate"]: r["close"] for r in rows if r.get("tradeDate")}
        ours = {d.replace("-", ""): v for d, v in (SER.get("hs300", {}).get("points") or [])}
        common = sorted(set(off) & set(ours))
        if not common:
            return {"ok": None, "note": "与官方无共同交易日"}
        d0 = common[-1]
        a, b = float(off[d0]), float(ours[d0])
        diff = abs(a - b) / b * 100 if b else None
        return {"ok": diff is not None and diff <= 0.05, "date": d0,
                "official": round(a, 2), "local": round(b, 2),
                "diff_pct": round(diff, 4) if diff is not None else None}
    except Exception as e:
        return {"ok": None, "note": "校验失败：" + str(e)[:80]}


data["checks"]["csindex"] = verify_csindex()
if data["checks"]["csindex"].get("ok") is False:
    data["errors"].append("沪深 300 与中证官网偏差超阈值：" +
                          json.dumps(data["checks"]["csindex"], ensure_ascii=False))

# =====================================================================
# 12. 序列清理 + 落盘
# =====================================================================
SER.pop("__", None)
for k in list(SER.keys()):
    if len(SER[k]["points"]) < 3:
        SER.pop(k)

with open(OUT, "w", encoding="utf-8") as f_:
    json.dump(data, f_, ensure_ascii=False, indent=1)

print("OK", OUT)
print("asof:", data.get("asof"))
print("series:", len(SER), sorted(SER.keys()))
print("cards:", json.dumps([c["badge"] for c in data["cards"]], ensure_ascii=False))
print("errors:", json.dumps(data["errors"], ensure_ascii=False))
