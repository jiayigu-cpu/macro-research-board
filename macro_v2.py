# -*- coding: utf-8 -*-
"""宏观量化看板 v2 · 计算层

输入：fetch_data.py 产出的 series 字典（及可选的行业计算结果）
输出：data.json 的 macro_v2 字段，供前端三张结论卡与五个模块共用一套结果。

设计原则
1. 只算一次、多处引用：三轴、卦限、库存阶段、仓位、政策强度、六因子、风格分，
   全部在这里落成一份结构，前端不再二次推导。
2. 缺数据不猜数：任何一项输入缺失，输出 available=False + 原因，前端显示「数据更新中」。
   允许降级代理，但必须在 note 里写明代理口径。
3. 可独立运行：`python3 macro_v2.py` 直接在 data.json 上重算 macro_v2，便于本地预览。

依赖：仅标准库。运行环境不需要 numpy / pandas。
"""
from __future__ import annotations

import json
import math
import os
import statistics
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "data.json")

EPS = 0.02          # 方向判定死区（百分点）
MONTHS_TRAIL = 12   # 卦限轨迹保留月数


# =====================================================================
# 基础工具
# =====================================================================
def _pts(SER, key):
    return (SER.get(key) or {}).get("points") or []


def _map(SER, key, monthly=False):
    out = {}
    for lab, v in _pts(SER, key):
        try:
            fv = float(v)
        except Exception:
            continue
        k = str(lab)[:7] if monthly else str(lab)
        out[k] = fv
    return out


def align_monthly(SER, keys):
    """把多条月频序列对齐到同一组月份，缺失按前值结转（发布节奏不同导致的空洞不算变化）。"""
    maps = {k: _map(SER, k, True) for k in keys}
    months = sorted({m for k in keys for m in maps[k]})
    out = {}
    for k in keys:
        arr, last = [], None
        for mo in months:
            if mo in maps[k]:
                last = maps[k][mo]
            arr.append(last)
        out[k] = arr
    return months, out


def ma_at(arr, i, n):
    """arr[i] 结尾的 n 期简单均值；不足 n 期或有缺口时返回 None。"""
    if i - n + 1 < 0:
        return None
    seg = arr[i - n + 1:i + 1]
    if any(v is None for v in seg):
        return None
    return sum(seg) / n


def direction(arr, i, n=3, span=3, eps=EPS):
    """n 期均线相对 span 期前的变化方向。"""
    a, b = ma_at(arr, i, n), ma_at(arr, i - span, n)
    if a is None or b is None:
        return "na", None
    d = a - b
    if abs(d) < eps:
        return "flat", d
    return ("up" if d > 0 else "down"), d


def zscore(vals, win=None):
    v = vals[-1] if vals else None
    s = [x for x in (vals[-win:] if win else vals) if x is not None]
    if len(s) < 12 or v is None:
        return None
    mu = sum(s) / len(s)
    sd = statistics.pstdev(s)
    if not sd:
        return None
    return (v - mu) / sd


def pctile(vals, v, win=None):
    s = [x for x in (vals[-win:] if win else vals) if x is not None]
    if len(s) < 20 or v is None:
        return None
    return round(sum(1 for x in s if x <= v) / len(s), 4)


def dirstr(d):
    return {"up": "上行", "down": "下行", "flat": "走平", "na": "待定"}[d]


def rnd(v, nd=1):
    return None if v is None else round(v, nd)


def rng(arr, n):
    """取序列最后 n 个非空值（保持顺序）。"""
    out = [v for v in arr if v is not None]
    return out[-n:]


# =====================================================================
# 0. 静态定义：8 卦限（与前端 config.js 同源，前端以 config 为准）
# =====================================================================
OCTANTS = {
    1: {"name": "衰退", "meaning": "通缩压力，防御优先",
        "assets": "债券 > 股票；红利、公用事业", "tone": "neg"},
    2: {"name": "政策驱动行情", "meaning": "基本面没动、水多，估值行情",
        "assets": "大金融 + 主题 TMT；交易性思路", "tone": "mid"},
    3: {"name": "滞胀", "meaning": "最差组合，系统性降仓",
        "assets": "现金、黄金；系统性降仓", "tone": "neg"},
    4: {"name": "滞胀·救市", "meaning": "类滞胀中政策被迫宽松",
        "assets": "黄金 > 商品 > 股票；公用事业", "tone": "mid"},
    5: {"name": "复苏确认·收敛", "meaning": "基本面好但政策边际收敛，赚盈利的钱",
        "assets": "中游制造 / TMT 成长、选股重于仓位", "tone": "pos"},
    6: {"name": "复苏初期", "meaning": "盈利起、物价低、钱多，权益最优环境",
        "assets": "股票 > 债券；上游资源 + 中游制造", "tone": "pos"},
    7: {"name": "过热收紧", "meaning": "政策压制估值",
        "assets": "商品强、债券弱、权益结构性", "tone": "mid"},
    8: {"name": "过热·惯性宽松", "meaning": "量价齐升，防通胀抬头",
        "assets": "商品 > 股票；周期品", "tone": "neg"},
}

KITCHIN = {
    ("up", "up"): ("主动补库", 2),
    ("up", "down"): ("被动去库", 1),
    ("down", "down"): ("主动去库", 4),
    ("down", "up"): ("被动补库", 3),
}


# =====================================================================
# 1. 三轴 + 卦限
# =====================================================================
def build_axes(SER):
    keys = ["iav", "pmi", "cpi", "ppi", "scissors", "surplus_m1ppi", "m1", "m2"]
    months, M = align_monthly(SER, keys)
    if len(months) < 12:
        return None, None, None
    i = len(months) - 1
    comp = [None if (c is None or p is None) else 0.4 * c + 0.6 * p
            for c, p in zip(M["cpi"], M["ppi"])]
    M["infl_comp"] = comp
    surplus_med = statistics.median([v for v in M["surplus_m1ppi"] if v is not None])

    def bits_at(j):
        g_dir, g_d = direction(M["iav"], j, 3, 3, 0.05)
        pmi2 = (M["pmi"][j] is not None and M["pmi"][j] > 50
                and j >= 1 and M["pmi"][j - 1] is not None and M["pmi"][j - 1] > 50)
        g = 1 if (g_dir == "up" or pmi2) else 0
        i_dir, i_d = direction(M["infl_comp"], j, 3, 3, 0.05)
        inf = 1 if i_dir == "up" else 0
        l_dir, l_d = direction(M["scissors"], j, 3, 3, 0.05)
        lvl = M["surplus_m1ppi"][j] is not None and M["surplus_m1ppi"][j] > surplus_med
        liq = 1 if (l_dir == "up" or (l_dir == "flat" and lvl) or (lvl and l_dir != "down")) else 0
        return g, inf, liq, {"g_dir": g_dir, "g_delta": g_d, "pmi2": pmi2,
                             "i_dir": i_dir, "i_delta": i_d,
                             "l_dir": l_dir, "l_delta": l_d, "liq_level": lvl}

    g, inf, liq, now = bits_at(i)
    oid = 4 * g + 2 * inf + liq + 1
    o = OCTANTS[oid]

    # 12 个月轨迹
    trail = []
    for j in range(max(0, i - MONTHS_TRAIL + 1), i + 1):
        b = bits_at(j)
        trail.append({"m": months[j], "id": 4 * b[0] + 2 * b[1] + b[2] + 1})

    # 进入当前卦限的月份
    since = months[i]
    for j in range(i - 1, max(5, i - 36) - 1, -1):
        b = bits_at(j)
        if 4 * b[0] + 2 * b[1] + b[2] + 1 == oid:
            since = months[j]
        else:
            break

    axes = {
        "growth": {
            "direction": "up" if g else "down",
            "label": "增长" + ("上行" if g else "下行"),
            "value": rnd(M["iav"][i]),
            "pmi": rnd(M["pmi"][i]),
            "note": f"工业增加值同比 {rnd(M['iav'][i])}%（3 月均线{dirstr(now['g_dir'])}）"
                    f"；PMI {rnd(M['pmi'][i])}" + ("（连续 2 月荣枯线上）" if now["pmi2"] else "（荣枯线下）"),
            "rule": "工业增加值同比 3 月均线方向向上，或 PMI 连续 2 个月 > 50，判为增长上行",
            "series": "iav",
        },
        "inflation": {
            "direction": "up" if inf else "down",
            "label": "通胀" + ("上行" if inf else "下行"),
            "value": rnd(M["ppi"][i]),
            "cpi": rnd(M["cpi"][i]),
            "composite": rnd(M["infl_comp"][i], 2),
            "note": f"0.4×CPI({rnd(M['cpi'][i])}%) + 0.6×PPI({rnd(M['ppi'][i])}%) = "
                    f"{rnd(M['infl_comp'][i], 2)}%，3 月均线{dirstr(now['i_dir'])}",
            "rule": "合成通胀 0.4×CPI + 0.6×PPI，3 月均线方向向上判为通胀上行（PPI 权重更高，对应上游传导）",
            "series": "ppi",
        },
        "liquidity": {
            "direction": "up" if liq else "down",
            "label": "流动性" + ("宽松" if liq else "收紧"),
            "value": rnd(M["scissors"][i]),
            "surplus": rnd(M["surplus_m1ppi"][i]),
            "note": f"M1−M2 {rnd(M['scissors'][i])}pp（{dirstr(now['l_dir'])}）"
                    f"；M1−PPI {rnd(M['surplus_m1ppi'][i])}pp"
                    f"（历史上半区{'是' if now['liq_level'] else '否'}）",
            "rule": "M1−M2 剪刀差 3 月均线向上，或 M1−PPI 剩余流动性高于历史中位数，判为流动性宽松",
            "series": "scissors",
        },
    }
    octant = {
        "id": oid, "name": o["name"], "meaning": o["meaning"], "assets": o["assets"],
        "tone": o["tone"], "since": since, "months_in": _month_span(since, months[i]),
        "trail": trail, "bits": {"growth": g, "inflation": inf, "liquidity": liq},
        "formula": "octant_id = 4×增长上行 + 2×通胀上行 + 1×流动性宽松 + 1",
    }
    return axes, octant, M


def _month_span(a, b):
    try:
        ya, ma_ = int(a[:4]), int(a[5:7])
        yb, mb = int(b[:4]), int(b[5:7])
        return (yb - ya) * 12 + (mb - ma_) + 1
    except Exception:
        return None


# =====================================================================
# 2. 库存周期
# =====================================================================
def build_inventory(SER, M, months):
    i = len(months) - 1
    iav, ppi = M["iav"], M["ppi"]
    nominal = [None if (a is None or b is None) else a + b for a, b in zip(iav, ppi)]

    def stage_at(j):
        d_dir, _ = direction(iav, j, 3, 2, 0.05)
        s_dir, _ = direction(nominal, j, 3, 2, 0.05)
        if d_dir in ("na", "flat") or s_dir in ("na", "flat"):
            return None, d_dir, s_dir
        return KITCHIN[(d_dir, s_dir)], d_dir, s_dir

    st, d_dir, s_dir = stage_at(i)
    if not st:
        return {"available": False, "note": "需求或库存方向待定，暂无法判定库存周期阶段",
                "demand": dirstr(d_dir), "stock": dirstr(s_dir)}
    name, sid = st
    months_in, j, prev = 1, i - 1, sid
    while j >= 5:
        s2 = stage_at(j)[0]
        if not s2 or s2[1] != prev:
            break
        months_in += 1
        j -= 1
    return {
        "available": True, "stage": name, "stage_id": sid, "months_in": months_in,
        "demand": dirstr(d_dir), "stock": dirstr(s_dir),
        "value_demand": rnd(iav[i]), "value_stock": rnd(nominal[i]),
        "note": f"需求（工业增加值同比 {rnd(iav[i])}%）{dirstr(d_dir)} × "
                f"库存（名义工业增长 {rnd(nominal[i])}%）{dirstr(s_dir)} → {name}",
        "rule": "需求用工业增加值同比方向代理，库存用名义工业增长（工业增加值+PPI）方向代理；"
                "产成品存货同比接口当前不可得，故以量价合成的名义增长代替库存增速方向",
        "proxy": True,
    }


# =====================================================================
# 3. 仓位（基钦 × 季节）
# =====================================================================
def build_position(SER, inv):
    # 季节方向：近 4 个月成交额高点距今时长 + 融资余额方向
    pts = _pts(SER, "amount")
    season, season_note, detail = "na", "", []
    if len(pts) > 30:
        last_d = datetime.strptime(pts[-1][0][:10], "%Y-%m-%d")
        window = pts[-80:]
        peak = max(window, key=lambda p: p[1])
        peak_d = datetime.strptime(peak[0][:10], "%Y-%m-%d")
        gap_m = (last_d - peak_d).days / 30.4
        timing = "down" if gap_m <= 1.5 else "up"
        margin = _pts(SER, "margin_bal")
        m_dir = "na"
        if len(margin) > 25:
            m_dir = "up" if margin[-1][1] > margin[-25][1] else "down"
        if timing == "down":
            season = "down"
            season_note = (f"成交额高点距今 {gap_m:.1f} 个月（{peak[0][:10]}，峰值 {peak[1]:,.0f} 亿元）"
                           f"→ 刚过峰值，季节下行")
        else:
            season = "up" if m_dir != "down" else "down"
            season_note = (f"成交额高点距今 {gap_m:.1f} 个月（{peak[0][:10]}，已过峰值），"
                           f"融资余额 20 日{'回升' if m_dir == 'up' else '回落' if m_dir == 'down' else '待接入'}"
                           f" → 季节{'上行' if season == 'up' else '下行'}")
        detail = [
            f"成交额近 80 个交易日峰值：{peak[1]:,.0f} 亿元（{peak[0][:7]}），距今 {gap_m:.1f} 个月",
            f"融资余额近 20 个交易日：{'回升' if m_dir == 'up' else '回落' if m_dir == 'down' else '待接入'}",
            "规则：峰值距今 ≤ 1.5 个月视为季节下行；否则由融资余额方向确认，冲突时以成交额时序为准",
        ]
    if not inv.get("available"):
        return {"available": False, "note": "库存周期未定，仓位暂不给出"}

    kitchin = "up" if inv["stage_id"] in (1, 2) else "down"
    if season == "na":
        return {"available": False, "note": "季节方向数据不足（成交额/融资余额待接入）",
                "kitchin": "up" if kitchin == "up" else "down"}

    matrix = {("up", "up"): ("full", "满仓", "基钦向上 × 季节向上 = 大幅加仓"),
              ("up", "down"): ("half", "半仓", "基钦向上 × 季节向下 = 震荡整理"),
              ("down", "up"): ("half", "半仓", "基钦向下 × 季节向上 = 可交易反弹"),
              ("down", "down"): ("empty", "空仓", "基钦向下 × 季节向下 = 大幅下跌")}
    tier, label, reason = matrix[(kitchin, season)]
    return {
        "available": True, "tier": tier, "label": label, "reason": reason,
        "kitchin": "up" if kitchin == "up" else "down",
        "kitchin_label": inv["stage"],
        "season": season, "season_note": season_note,
        "detail": detail,
        "rule": "基钦方向取库存周期阶段（被动去库/主动补库=向上，主动去库/被动补库=向下）；"
                "季节方向取近 3–4 个月成交额高点距今时长，并用融资余额方向确认",
        "history": "该规则 2016.9 以来沪深 300 择时累计超额 110.5%（华鑫口径，仅供参照）",
        "boundary": "情绪周期（约 20 个交易日）不进仓位规则，只作为灵活仓位提示",
    }


def _shibor_monthly(SER):
    """7 天 SHIBOR 月均。优先用抓数层预算好的月频序列，缺失时由日频聚合。"""
    m = _map(SER, "shibor_7d_m", True)
    if len(m) >= 12:
        return m
    sh = _map(SER, "shibor_7d")
    agg = {}
    for k, v in sh.items():
        agg.setdefault(k[:7], []).append(v)
    return {k: sum(v) / len(v) for k, v in agg.items()}


def _madd(m, n):
    """月份串（YYYY-MM）加减 n 个月。"""
    y, mo = int(m[:4]), int(m[5:7])
    t = y * 12 + (mo - 1) + n
    return "%04d-%02d" % (t // 12, t % 12 + 1)


def _ttm_yoy(m):
    """月度增量序列 → 12 个月滚动求和同比（%）。"""
    ks = sorted(m)
    ttm = {}
    for j in range(11, len(ks)):
        seg = [m[x] for x in ks[j - 11:j + 1]]
        if all(v is not None for v in seg):
            ttm[ks[j]] = sum(seg)
    tk = sorted(ttm)
    out = {}
    for j in range(12, len(tk)):
        if ttm[tk[j - 12]]:
            out[tk[j]] = (ttm[tk[j]] / ttm[tk[j - 12]] - 1) * 100
    return out


def credit_impulse(SER):
    """社融脉冲 = 新增社融 12 个月滚动求和同比。

    央行社融增量接口常滞后数月（本次实测停在 2026-04），若落后于月度基准时点超 3 个月，
    自动改用人民币贷款增量同比代理，并在 detail 里注明口径切换——两者同向，做趋势跟踪够用。
    """
    ref = align_monthly(SER, ["iav", "fai_yoy"])[0]
    refm = ref[-1] if ref else None
    cutoff = _madd(refm, -3) if refm else None
    sf = _ttm_yoy(_map(SER, "sf_inc", True))
    ln = _ttm_yoy(_map(SER, "credit_inc", True))
    if len(sf) >= 24 and (cutoff is None or sorted(sf)[-1] >= cutoff):
        k = sorted(sf)[-1]
        return {"series": sf, "asof": k,
                "detail": "社融 TTM 同比 %+.1f%%（%s）" % (sf[k], k)}
    if len(ln) >= 24:
        k = sorted(ln)[-1]
        tail = "；社融增量接口停在 %s，此处用人民币贷款增量同比代理" % sorted(sf)[-1] if sf else ""
        return {"series": ln, "asof": k,
                "detail": "贷款增量 TTM 同比 %+.1f%%（%s%s）" % (ln[k], k, tail)}
    if len(sf) >= 24:
        k = sorted(sf)[-1]
        return {"series": sf, "asof": k,
                "detail": "社融 TTM 同比 %+.1f%%（%s，接口滞后）" % (sf[k], k)}
    return None


# =====================================================================
# 4. 政策强度指数
# =====================================================================
def build_policy(SER):
    parts, notes = [], []
    # 社融脉冲：新增社融 TTM 同比，接口滞后时由 credit_impulse 自动换口径
    ci = credit_impulse(SER)
    if ci:
        yk = sorted(ci["series"])
        z = zscore([ci["series"][m] for m in yk], 60)
        if z is not None:
            parts.append({"k": "社融脉冲", "w": 0.4, "z": round(z, 2), "detail": ci["detail"]})
            notes.append("社融脉冲 = " + ci["detail"])
    # 财政力度（代理）：财政收入累计同比分位标准分
    fz = [v for v in M_fiscal(SER) if v is not None]
    if len(fz) >= 24:
        z = zscore(fz, 60)
        if z is not None:
            parts.append({"k": "财政力度", "w": 0.3, "z": round(z, 2),
                          "detail": f"财政收入累计同比 {fz[-1]:.1f}%（支出端接口不可得，以收入端代理）"})
            notes.append("财政支出同比接口（财政部）当前不可得，以财政收入累计同比作方向代理")
    # 货币价格：7 天 SHIBOR 3 个月变化取负
    sm = _shibor_monthly(SER)
    if len(sm) >= 15:
        mk = sorted(sm)
        avg = [sm[m] for m in mk]
        diffs = [avg[j] - avg[j - 3] for j in range(3, len(avg))]
        z = zscore([-d for d in diffs], 36)
        if z is not None:
            parts.append({"k": "货币价格", "w": 0.1, "z": round(z, 2),
                          "detail": f"7 天 SHIBOR 近 3 月变化 {diffs[-1]:+.2f}pp（利率下行记为宽松）"})
            notes.append("OMO 7 天利率按 7 天 SHIBOR 月均代理，用于捕捉货币价格方向")

    if not parts:
        return {"available": False, "note": "政策强度指数的输入全部缺失"}
    wsum = sum(p["w"] for p in parts)
    # 24 个月走势 + 5 年分位：用同一套可用成分逐月重算，指数取最新一个月，保证走势与读数同源
    hist = policy_history(SER)
    pct = None
    if hist:
        vals = [h["v"] for h in hist]
        pct = pctile(vals, vals[-1], 60)
        index_now = vals[-1]
    else:
        index_now = sum(p["z"] * p["w"] for p in parts) / wsum
    return {
        "available": True, "index": round(index_now, 2),
        "percentile": pct,
        "asof": hist[-1]["m"] if hist else (ci["asof"] if ci else None),
        "coverage": hist[-1].get("cov") if hist else None,
        "parts": [dict(p, w=round(p["w"] / wsum, 3)) for p in parts],
        "missing": "专项债发行进度同比（财政部/中债接口不可得），权重已在可用成分内归一",
        "series": hist[-24:],
        "note": "；".join(notes),
        "formula": "index = 0.4·z(社融脉冲) + 0.3·z(财政支出同比) + 0.2·z(专项债进度同比) + 0.1·z(−Δ7天OMO)；"
                   "缺项时权重在可用成分内归一，展示为近 5 年分位",
    }


def M_fiscal(SER):
    return [v for v in align_monthly(SER, ["fiscal_cum_yoy"])[1]["fiscal_cum_yoy"] if v is not None]


def policy_history(SER):
    """逐月重算政策强度（只用可用成分，权重归一），用于走势与分位。"""
    series = {}
    ci = credit_impulse(SER)
    if ci and len(ci["series"]) >= 24:
        series["社融脉冲"] = (ci["series"], 0.4)
    fz = align_monthly(SER, ["fiscal_cum_yoy"])
    series["财政力度"] = ({m: v for m, v in zip(fz[0], fz[1]["fiscal_cum_yoy"]) if v is not None}, 0.3)
    sh = _shibor_monthly(SER)
    if len(sh) >= 15:
        mk = sorted(sh)
        avg = {m: sh[m] for m in mk}
        series["货币价格"] = ({mk[j]: -(avg[mk[j]] - avg[mk[j - 3]]) for j in range(3, len(mk))}, 0.1)
    if not series:
        return []
    months = sorted({m for s, _ in series.values() for m in s})
    wmax = sum(w for _, w in series.values())
    out = []
    for j, m in enumerate(months):
        num = den = 0.0
        for s, w in series.values():
            window = [s[x] for x in months[:j + 1] if x in s][-60:]
            if m not in s or len(window) < 12:
                continue
            mu = sum(window) / len(window)
            sd = statistics.pstdev(window)
            if not sd:
                continue
            num += ((s[m] - mu) / sd) * w
            den += w
        # 成分不足的月份（月末指标发布节奏不一）不参与，否则单成分月份的指数与多成分月份不可比
        if den >= 0.6 * wmax:
            out.append({"m": m, "v": round(num / den, 3), "cov": round(den / wmax, 2)})
    return out


# =====================================================================
# 5. 六因子
# =====================================================================
FACTORS = [
    ("growth", "增长", "PMI 与工业增加值同比的合成 z 分数", "官方数据 + 高频合成"),
    ("inflation", "通胀", "0.4×CPI + 0.6×PPI 的 z 分数", "官方数据 + 高频合成"),
    ("rate", "利率", "10Y 国债收益率 60 日变化的相反数", "中债收益率曲线（高频化）"),
    ("credit", "信用", "信用利差（反向）与贷款累计同比的合成", "中债估值 + 央行"),
    ("fx", "汇率", "USD/CNY 20 日变动与中美利差（反向）的合成", "外汇交易中心 + 美债"),
    ("liquidity", "流动性", "M1−M2 与 M1−PPI 的合成", "官方数据 + 高频合成"),
]


def build_factors(SER, M):
    months, MM = align_monthly(SER, ["pmi", "iav", "cpi", "ppi", "scissors",
                                     "surplus_m1ppi", "credit_cum_yoy"])
    comp = [None if (c is None or p is None) else 0.4 * c + 0.6 * p
            for c, p in zip(MM["cpi"], MM["ppi"])]
    growth_raw = [None if (a is None or b is None) else 0.5 * (b - 50) + 0.5 * a
                  for a, b in zip(MM["iav"], MM["pmi"])]
    liq_raw = [None if (a is None or b is None) else 0.5 * a + 0.5 * b
               for a, b in zip(MM["scissors"], MM["surplus_m1ppi"])]
    y10 = _map(SER, "y10")
    cs = _map(SER, "cspread")
    fx = _map(SER, "usdcny")
    cnus = _map(SER, "cnus10")
    raw = {
        "growth": (growth_raw, "monthly", 60, "PMI 与工业增加值合成"),
        "inflation": (comp, "monthly", 60, "0.4CPI+0.6PPI"),
        "liquidity": (liq_raw, "monthly", 60, "M1−M2 与 M1−PPI 合成"),
        "credit": (MM["credit_cum_yoy"], "monthly", 60, "贷款累计同比"),
    }
    scores = {}
    for k, (arr, _, win, _label) in raw.items():
        v = [x for x in arr if x is not None]
        z = zscore(v, win)
        scores[k] = z

    # 利率：日频 Δ60 的相反数
    if len(y10) >= 120:
        ks = sorted(y10)
        d60 = [y10[ks[j]] - y10[ks[j - 60]] for j in range(60, len(ks))]
        z = zscore([-x for x in d60], 750)
        if z is not None:
            scores["rate"] = z
    # 信用：利差反向
    if len(cs) >= 120:
        kv = sorted(cs)
        zs = zscore([cs[m] for m in kv], 750)
        if zs is not None:
            scores["credit"] = (statistics.mean([-zs, scores.get("credit") or 0])
                                if scores.get("credit") is not None else -zs)
    # 汇率：USD/CNY 20 日变动 + 中美利差反向
    if len(fx) >= 60:
        kx = sorted(fx)
        d20 = [(fx[kx[j]] / fx[kx[j - 20]] - 1) * 100 for j in range(20, len(kx))]
        z1 = zscore(d20, 500)
        z2 = None
        if len(cnus) >= 60:
            kc = sorted(cnus)
            z2 = zscore([-cnus[m] for m in kc], 500)
        if z1 is not None:
            scores["fx"] = statistics.mean([z1, z2]) if z2 is not None else z1

    out = []
    for key, name, construct, src in FACTORS:
        z = scores.get(key)
        if z is None:
            out.append({"id": key, "name": name, "available": False,
                        "construct": construct, "src": src,
                        "note": "输入序列缺失"})
            continue
        z = max(-2.0, min(2.0, z))
        out.append({
            "id": key, "name": name, "available": True,
            "score": round(z, 2), "strength": round(min(1.0, abs(z) / 2), 2),
            "direction": "up" if z > 0.15 else "down" if z < -0.15 else "flat",
            "construct": construct, "src": src,
            "read": factor_read(key, z),
        })
    return out


def factor_read(k, z):
    m = {"growth": ("增长动能强于历史均值", "增长动能弱于历史均值"),
         "inflation": ("通胀压力高于均值", "通胀压力低于均值"),
         "rate": ("利率下行，宽松", "利率上行，收紧"),
         "credit": ("信用扩张", "信用收缩"),
         "fx": ("人民币贬值压力上升", "人民币贬值压力缓解"),
         "liquidity": ("流动性宽松", "流动性收紧")}
    a, b = m[k]
    if z > 0.15:
        return a
    if z < -0.15:
        return b
    return "接近历史均值"


# =====================================================================
# 6. 成长 / 价值 9 信号
# =====================================================================
STYLE_SIGNALS = [
    ("mom", "价格动量", "交易", "沪深 300 近 60 日收益为正 → 成长"),
    ("turn", "成交额动量", "交易", "成交额 MA20 高于 60 日前 → 成长"),
    ("big", "超大单占比", "资金流", "超大单净流入占比 20 日均值为正 → 成长"),
    ("margin", "融资买盘比", "资金流", "融资余额 20 日回升 → 成长"),
    ("profit", "净利润增速", "基本面", "全 A 净利润增速上行 → 成长"),
    ("div", "股息比", "基本面", "股息率高于 10Y 国债 → 价值"),
    ("ppicpi", "PPI−CPI 分位", "宏观", "PPI−CPI 高于 5 年中位 → 成长"),
    ("fai", "固投分位", "宏观", "固定资产投资同比高于 5 年中位 → 价值"),
    ("m1m2", "M1−M2 分位", "宏观", "M1−M2 高于 5 年中位 → 成长"),
]


def build_style(SER):
    hs = _map(SER, "hs300")
    amt = _map(SER, "amount")
    out = []

    def add(key, v, detail):
        out.append({"id": key, "v": v, "available": v is not None, "detail": detail})

    # 1 价格动量
    if len(hs) >= 70:
        ks = sorted(hs)
        r = (hs[ks[-1]] / hs[ks[-61]] - 1) * 100
        add("mom", 1 if r > 0 else -1, f"沪深 300 近 60 日 {r:+.1f}%")
    else:
        add("mom", None, "沪深 300 序列不足")
    # 2 成交额动量
    if len(amt) >= 70:
        ka = sorted(amt)
        a20 = sum(amt[k] for k in ka[-20:]) / 20
        a20p = sum(amt[k] for k in ka[-80:-60]) / 20
        chg = (a20 / a20p - 1) * 100
        add("turn", 1 if chg > 0 else -1, f"成交额 MA20 较 60 日前 {chg:+.1f}%")
    else:
        add("turn", None, "成交额序列不足")
    # 3 超大单占比
    ff = _map(SER, "big_flow_pct")
    if len(ff) >= 20:
        kf = sorted(ff)
        m = sum(ff[k] for k in kf[-20:]) / 20
        add("big", 1 if m > 0 else -1, f"超大单净流入占比 20 日均值 {m:+.2f}%")
    else:
        add("big", None, "资金流接口待接入")
    # 4 融资余额
    mg = _pts(SER, "margin_bal")
    if len(mg) > 25:
        d = mg[-1][1] / mg[-25][1] - 1
        add("margin", 1 if d > 0 else -1, f"融资余额 20 日 {d:+.2f}%")
    else:
        add("margin", None, "融资余额待接入")
    # 5 净利润增速（暂无公开免密接口）
    add("profit", None, "全 A 净利润增速需财报接口，暂未接入")
    # 6 股息比
    dy = _pts(SER, "div_yield")
    y10 = _pts(SER, "y10")
    if dy and y10:
        ratio = dy[-1][1] / y10[-1][1] if y10[-1][1] else None
        if ratio:
            add("div", -1 if ratio > 1 else 1,
                f"股息率 {dy[-1][1]:.2f}% ÷ 10Y 国债 {y10[-1][1]:.2f}% = {ratio:.2f}")
        else:
            add("div", None, "股息率数据异常")
    else:
        add("div", None, "股息率待接入")
    # 7 PPI-CPI 分位
    months, MM = align_monthly(SER, ["ppi", "cpi"])
    spread = [(p - c) for p, c in zip(MM["ppi"], MM["cpi"]) if p is not None and c is not None]
    if len(spread) >= 36:
        pc = pctile(spread, spread[-1], 60)
        add("ppicpi", 1 if (pc or .5) > .5 else -1, f"PPI−CPI {spread[-1]:.1f}pp，5 年分位 {pc}")
    else:
        add("ppicpi", None, "PPI/CPI 序列不足")
    # 8 固投分位
    fai = [v for v in align_monthly(SER, ["fai_yoy"])[1]["fai_yoy"] if v is not None]
    if len(fai) >= 24:
        pf = pctile(fai, fai[-1], 60)
        add("fai", -1 if (pf or .5) > .5 else 1, f"固投同比 {fai[-1]:.1f}%，5 年分位 {pf}")
    else:
        add("fai", None, "固投接口待接入")
    # 9 M1-M2 分位
    sc = [v for v in align_monthly(SER, ["scissors"])[1]["scissors"] if v is not None]
    if len(sc) >= 36:
        ps = pctile(sc, sc[-1], 60)
        add("m1m2", 1 if (ps or .5) > .5 else -1, f"M1−M2 {sc[-1]:.1f}pp，5 年分位 {ps}")
    else:
        add("m1m2", None, "M1−M2 序列不足")

    avail = [s for s in out if s["available"]]
    score = round(sum(s["v"] for s in avail) / len(avail), 2) if avail else None
    return {
        "available": bool(avail), "score": score,
        "n_available": len(avail), "n_total": len(out),
        "label": ("偏成长" if (score or 0) > 0.2 else "偏价值" if (score or 0) < -0.2 else "均衡") if score is not None else "待接入",
        "signals": out,
        "note": f"9 个子信号等权；当前 {len(avail)}/{len(out)} 个可用，缺失项不计入分母（不做插补）",
        "rule": "子信号 +1 指成长、−1 指价值，总分 > 0 配成长、< 0 配价值",
    }


# =====================================================================
# 7. 趋势保护
# =====================================================================
TREND_ASSETS = [("A股", "tr_hs300"), ("利率债", "tr_bond"), ("商品", "tr_sc"), ("黄金", "tr_gold")]


def _macd(vals, fast=12, slow=26, sig=9):
    if len(vals) < slow + sig:
        return None, None
    ef, es = _ema(vals, fast), _ema(vals, slow)
    dif = [a - b for a, b in zip(ef, es)]
    dea = _ema(dif, sig)
    return dif[-1], dea[-1]


def _ema(vals, n):
    k = 2 / (n + 1)
    out, e = [], vals[0]
    for v in vals:
        e = v * k + e * (1 - k)
        out.append(e)
    return out


def build_trend(SER):
    rows = []
    for name, key in TREND_ASSETS:
        pts = _pts(SER, key)
        vals = [p[1] for p in pts]
        if len(vals) < 40:
            rows.append({"asset": name, "available": False, "note": "月线不足 40 期"})
            continue
        ma10 = sum(vals[-10:]) / 10
        ma30 = sum(vals[-30:]) / 30
        dif, dea = _macd(vals[-80:])
        mu = sum(vals[-20:]) / 20
        sd = statistics.pstdev(vals[-20:])
        lower, upper = mu - 2 * sd, mu + 2 * sd
        close = vals[-1]
        sig = {"ma": "up" if close > ma10 > ma30 else "down",
               "macd": "up" if (dif is not None and dea is not None and dif > dea) else "down",
               "boll": "up" if close > lower else "down"}
        broken = [k for k, v in sig.items() if v == "down"]
        rows.append({
            "asset": name, "available": True, "close": round(close, 2),
            "ma10": round(ma10, 2), "ma30": round(ma30, 2),
            "dif": None if dif is None else round(dif, 3),
            "dea": None if dea is None else round(dea, 3),
            "boll_lower": round(lower, 2), "boll_upper": round(upper, 2),
            "signals": sig,
            "broken": bool(broken),
            "broken_parts": [{"ma": "双均线", "macd": "MACD", "boll": "布林带"}[b] for b in broken],
            "read": ("趋势破位：" + "、".join({"ma": "双均线", "macd": "MACD", "boll": "布林带"}[b] for b in broken))
                    if broken else "趋势完好",
        })
    return {"available": any(r.get("available") for r in rows), "rows": rows,
            "rule": "月频：双均线（10/30）、MACD（12,26,9）、布林带（20,2σ）；任一破位即标「趋势破位」，作为所有配置建议的保护层",
            "note": "利率债用 10Y 国债收益率取负作价格代理，商品用 INE 原油连续，黄金用沪金主连"}


# =====================================================================
# 8. ERP
# =====================================================================
def build_erp(SER):
    erp = _map(SER, "erp")
    if not erp:
        return {"available": False, "note": "ERP 序列缺失"}
    ks = sorted(erp)
    vals = [erp[k] for k in ks]
    return {"available": True, "value": round(vals[-1], 2),
            "pctile": pctile(vals, vals[-1], 60), "asof": ks[-1],
            "series": [{"m": k, "v": round(v, 2)} for k, v in zip(ks[-48:], vals[-48:])],
            "note": "全 A 盈利收益率 − 10 年国债收益率；以当前 10Y 平移近似历史序列，保留形态与分位"}


# =====================================================================
# 主入口
# =====================================================================
def build(SER, industry=None):
    axes, octant, M = build_axes(SER)
    if axes is None:
        return {"available": False, "note": "月频序列不足，macro_v2 无法计算"}
    months, MM = align_monthly(SER, ["iav", "ppi", "pmi"])
    inv = build_inventory(SER, MM, months)
    pos = build_position(SER, inv)
    pol = build_policy(SER)
    fac = build_factors(SER, MM)
    sty = build_style(SER)
    tr = build_trend(SER)
    erp = build_erp(SER)
    return {
        "available": True,
        "asof": months[-1],
        "axes": axes,
        "octant": octant,
        "inventory": inv,
        "position": pos,
        "policy": pol,
        "factors": fac,
        "style": sty,
        "trend": tr,
        "erp": erp,
        "industry": industry or {"available": False, "note": "行业层未接入"},
    }


def main():
    with open(OUT, encoding="utf-8") as f:
        data = json.load(f)
    data["macro_v2"] = build(data.get("series") or {}, data.get("macro_v2", {}).get("industry"))
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    v = data["macro_v2"]
    if not v.get("available"):
        print("macro_v2 不可用：", v.get("note"))
        return
    print("卦限:", v["octant"]["id"], v["octant"]["name"], "进入", v["octant"]["since"])
    print("库存:", v["inventory"].get("stage"), v["inventory"].get("months_in"), "月")
    print("仓位:", v["position"].get("label"), "-", v["position"].get("reason"))
    print("政策:", v["policy"].get("index"), "分位", v["policy"].get("percentile"))
    print("六因子:", [(f["name"], f.get("score")) for f in v["factors"]])
    print("风格:", v["style"]["label"], v["style"]["score"], v["style"]["n_available"], "/9")
    print("趋势:", [(r["asset"], r.get("broken")) for r in v["trend"]["rows"]])
    print("ERP:", v["erp"].get("value"), v["erp"].get("pctile"))


if __name__ == "__main__":
    main()
