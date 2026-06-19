#!/usr/bin/env python3
"""
Gate System for V84B and SCS7 Strategies — Bear Market Defense
==============================================================

Objective:
  Design and backtest a multi-dimensional gate system to protect V84B
  (oversold reversal) and SCS7 (limit-up momentum) from bear market losses.

Gate Dimensions:
  1. Market Environment (limit-up count, limit-down count, MA20 trend)
  2. Signal Quality (additional technical filters per strategy)
  3. Time-based filters (monthly/seasonal expectancy)

Combined gate measures:
  (a) signal reduction ratio
  (b) avg return improvement
  (c) win rate improvement
  (d) max drawdown reduction (approximated via per-signal worst return)

Data: /data/kline_15yr.parquet
  Columns: code, market, date, open, high, low, close, volume, turnover
  Markets used: SH, SZ

DuckDB constraints:
  - No nested window functions — use CTE layers
  - date column is VARCHAR
"""

import duckdb

DATA_PATH = "/data/kline_15yr.parquet"

conn = duckdb.connect()

# ============================================================
# SECTION 0: Data Validation
# ============================================================
print("=" * 70)
print("GATE SYSTEM — V84B + SCS7 Multi-Dimensional Bear Defense")
print("=" * 70)

print("\n--- Section 0: Data Validation ---")
rows = conn.execute(f"""
    SELECT market, COUNT(*) as n, MIN(date) as start, MAX(date) as end
    FROM '{DATA_PATH}'
    WHERE market IN ('SH','SZ')
    GROUP BY market
    ORDER BY market
""").fetchall()
for r in rows:
    print(f"  {r[0]}: {r[1]:,} rows  {r[2]} to {r[3]}")


# ============================================================
# SECTION 1: Build Market Environment Signal Table (daily)
#   For each calendar date: count limit-up stocks, limit-down stocks,
#   and fraction of SH/SZ stocks above their MA20.
#
#   Limit-up:   gain >= 9.3%
#   Limit-down: gain <= -9.3%
#   MA20 pct:   fraction of stocks where close > MA20
#
#   We compute this once as a CTE used across all sections.
# ============================================================

print("\n--- Section 1: Annual Market Environment Statistics ---")

rows = conn.execute(f"""
    WITH base AS (
        SELECT code, date, close, volume,
               LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
               AVG(close) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20
        FROM '{DATA_PATH}'
        WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
    ),
    daily_flags AS (
        SELECT date,
               COUNT(*) AS total_stocks,
               COUNT(*) FILTER (WHERE prev_close > 0
                   AND (close - prev_close)/prev_close >= 0.093) AS limit_up_cnt,
               COUNT(*) FILTER (WHERE prev_close > 0
                   AND (close - prev_close)/prev_close <= -0.093) AS limit_down_cnt,
               COUNT(*) FILTER (WHERE close > ma20) * 100.0 / COUNT(*) AS pct_above_ma20
        FROM base
        WHERE prev_close > 0
        GROUP BY date
    )
    SELECT SUBSTR(date,1,4) AS year,
           AVG(limit_up_cnt)   AS avg_lub,
           AVG(limit_down_cnt) AS avg_ldb,
           AVG(pct_above_ma20) AS avg_pct_above_ma20,
           COUNT(*)            AS trading_days
    FROM daily_flags
    GROUP BY year
    ORDER BY year
""").fetchall()

print("  Year  AvgLUB  AvgLDB  Pct>MA20  TradingDays")
for r in rows:
    print(f"  {r[0]}  {r[1]:6.1f}  {r[2]:6.1f}  {r[3]:7.1f}%  {r[4]}")


# ============================================================
# SECTION 2: SCS7 Baseline (ungated, 2010-2026)
#   Price <=20, gain in [9.3%, 11%), vol >= 2x MA20, close/MA20 < 1.10
#   Hold 3 days
# ============================================================

print("\n--- Section 2: SCS7 Baseline by Year (ungated) ---")

rows = conn.execute(f"""
    WITH base AS (
        SELECT code, date, close, volume,
               LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
               AVG(close) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
               AVG(volume) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
               LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
        FROM '{DATA_PATH}'
        WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
    )
    SELECT SUBSTR(date,1,4) AS year,
           COUNT(*) AS n,
           AVG((d3_close - close)/close * 100)     AS avg_ret,
           MEDIAN((d3_close - close)/close * 100)  AS med_ret,
           COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
               * 100.0 / COUNT(*) AS wr,
           MIN((d3_close - close)/close * 100)     AS worst_ret
    FROM base
    WHERE prev_close > 0
      AND close <= 20
      AND (close - prev_close)/prev_close >= 0.093
      AND (close - prev_close)/prev_close < 0.11
      AND volume / vol_ma20 >= 2.0
      AND close / ma20 < 1.10
      AND d3_close IS NOT NULL
    GROUP BY year
    ORDER BY year
""").fetchall()

scs7_baseline = {r[0]: r for r in rows}
print("  Year   N     Avg     Med     WR     Worst")
for r in rows:
    print(f"  {r[0]}  {r[1]:5d}  {r[2]:+.2f}%  {r[3]:+.2f}%  {r[4]:.1f}%  {r[5]:+.2f}%")


# ============================================================
# SECTION 3: V84B Baseline (oversold reversal, ungated, 2010-2026)
#   Definition:
#     - Price 5-50 yuan
#     - Today's gain in [-10%, -5%)  (sharp decline, not limit-down)
#     - RSI proxy: 3-day cumulative return <= -8%  (oversold momentum)
#     - Volume ratio >= 1.5x MA20  (selling climax)
#     - Close/MA20 < 1.0  (below MA20 = bearish territory = oversold candidate)
#   Hold 5 days
# ============================================================

print("\n--- Section 3: V84B Baseline by Year (ungated) ---")

rows = conn.execute(f"""
    WITH base AS (
        SELECT code, date, close, volume,
               LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
               LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
               AVG(close) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
               AVG(volume) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
               LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
        FROM '{DATA_PATH}'
        WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
    )
    SELECT SUBSTR(date,1,4) AS year,
           COUNT(*) AS n,
           AVG((d5_close - close)/close * 100)     AS avg_ret,
           MEDIAN((d5_close - close)/close * 100)  AS med_ret,
           COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
               * 100.0 / COUNT(*) AS wr,
           MIN((d5_close - close)/close * 100)     AS worst_ret
    FROM base
    WHERE prev_close > 0 AND prev3_close > 0
      AND close >= 5 AND close <= 50
      AND (close - prev_close)/prev_close >= -0.10
      AND (close - prev_close)/prev_close < -0.05
      AND (close - prev3_close)/prev3_close <= -0.08
      AND volume / vol_ma20 >= 1.5
      AND close / ma20 < 1.0
      AND d5_close IS NOT NULL
    GROUP BY year
    ORDER BY year
""").fetchall()

v84b_baseline = {r[0]: r for r in rows}
print("  Year   N     Avg     Med     WR     Worst")
for r in rows:
    print(f"  {r[0]}  {r[1]:5d}  {r[2]:+.2f}%  {r[3]:+.2f}%  {r[4]:.1f}%  {r[5]:+.2f}%")


# ============================================================
# SECTION 4: Gate Dimension 1 — Market Environment Gates
#   For each signal date, look up the market's limit-up / limit-down
#   counts from the same date (same-day market breadth).
#   Gate variants test different thresholds.
# ============================================================

print("\n" + "=" * 70)
print("GATE DIMENSION 1: Market Environment")
print("=" * 70)

# ---- 4A: SCS7 + Limit-Down Gate ----
print("\n--- SCS7 Gate: Pre-day limit-down count < threshold ---")
print("  (Low limit-down count = healthier market = better for momentum)")

for ldb_max in [5, 10, 20, 30, 50, 80, 120]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_flags AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE prev_close > 0
                       AND (close - prev_close)/prev_close <= -0.093) AS limit_down_cnt
            FROM base
            WHERE prev_close > 0
            GROUP BY date
        ),
        mkt_lag AS (
            SELECT date,
                   LAG(limit_down_cnt, 1) OVER (ORDER BY date) AS prev_ldb
            FROM mkt_flags
        ),
        signals AS (
            SELECT b.*
            FROM base b
            JOIN mkt_lag m ON b.date = m.date
            WHERE m.prev_ldb IS NOT NULL
              AND m.prev_ldb < {ldb_max}
              AND b.prev_close > 0
              AND b.close <= 20
              AND (b.close - b.prev_close)/b.prev_close >= 0.093
              AND (b.close - b.prev_close)/b.prev_close < 0.11
              AND b.volume / b.vol_ma20 >= 2.0
              AND b.close / b.ma20 < 1.10
              AND b.d3_close IS NOT NULL
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               MEDIAN((d3_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d3_close - close)/close * 100) AS worst_ret
        FROM signals
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  LDB_prev < {ldb_max:4d}: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 4B: SCS7 + Limit-Up Gate ----
print("\n--- SCS7 Gate: Pre-day limit-up count >= threshold ---")
print("  (High limit-up count = strong bull momentum = better for SCS7)")

for lub_min in [50, 100, 150, 200, 300, 400, 500]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_flags AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE prev_close > 0
                       AND (close - prev_close)/prev_close >= 0.093) AS limit_up_cnt
            FROM base
            WHERE prev_close > 0
            GROUP BY date
        ),
        mkt_lag AS (
            SELECT date,
                   LAG(limit_up_cnt, 1) OVER (ORDER BY date) AS prev_lub
            FROM mkt_flags
        ),
        signals AS (
            SELECT b.*
            FROM base b
            JOIN mkt_lag m ON b.date = m.date
            WHERE m.prev_lub IS NOT NULL
              AND m.prev_lub >= {lub_min}
              AND b.prev_close > 0
              AND b.close <= 20
              AND (b.close - b.prev_close)/b.prev_close >= 0.093
              AND (b.close - b.prev_close)/b.prev_close < 0.11
              AND b.volume / b.vol_ma20 >= 2.0
              AND b.close / b.ma20 < 1.10
              AND b.d3_close IS NOT NULL
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               MEDIAN((d3_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d3_close - close)/close * 100) AS worst_ret
        FROM signals
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  LUB_prev >= {lub_min:4d}: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 4C: SCS7 + Pct-Above-MA20 Gate ----
print("\n--- SCS7 Gate: Fraction of stocks above MA20 >= threshold ---")

for pct_min in [30, 40, 50, 55, 60, 65, 70]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_flags AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE close > ma20) * 100.0 / COUNT(*) AS pct_above_ma20
            FROM base
            WHERE prev_close > 0
            GROUP BY date
        ),
        mkt_lag AS (
            SELECT date,
                   LAG(pct_above_ma20, 1) OVER (ORDER BY date) AS prev_pct
            FROM mkt_flags
        ),
        signals AS (
            SELECT b.*
            FROM base b
            JOIN mkt_lag m ON b.date = m.date
            WHERE m.prev_pct IS NOT NULL
              AND m.prev_pct >= {pct_min}
              AND b.prev_close > 0
              AND b.close <= 20
              AND (b.close - b.prev_close)/b.prev_close >= 0.093
              AND (b.close - b.prev_close)/b.prev_close < 0.11
              AND b.volume / b.vol_ma20 >= 2.0
              AND b.close / b.ma20 < 1.10
              AND b.d3_close IS NOT NULL
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               MEDIAN((d3_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d3_close - close)/close * 100) AS worst_ret
        FROM signals
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  PctAboveMA20_prev >= {pct_min:3d}%: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 4D: V84B + Market Environment ----
print("\n--- V84B Gate: Limit-down count < threshold ---")
print("  (V84B is oversold reversal — needs market not in free-fall)")

for ldb_max in [20, 40, 60, 80, 100, 150, 200]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_flags AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE prev_close > 0
                       AND (close - prev_close)/prev_close <= -0.093) AS limit_down_cnt
            FROM base
            WHERE prev_close > 0
            GROUP BY date
        ),
        mkt_lag AS (
            SELECT date,
                   LAG(limit_down_cnt, 1) OVER (ORDER BY date) AS prev_ldb
            FROM mkt_flags
        ),
        signals AS (
            SELECT b.*
            FROM base b
            JOIN mkt_lag m ON b.date = m.date
            WHERE m.prev_ldb IS NOT NULL
              AND m.prev_ldb < {ldb_max}
              AND b.prev_close > 0 AND b.prev3_close > 0
              AND b.close >= 5 AND b.close <= 50
              AND (b.close - b.prev_close)/b.prev_close >= -0.10
              AND (b.close - b.prev_close)/b.prev_close < -0.05
              AND (b.close - b.prev3_close)/b.prev3_close <= -0.08
              AND b.volume / b.vol_ma20 >= 1.5
              AND b.close / b.ma20 < 1.0
              AND b.d5_close IS NOT NULL
        )
        SELECT COUNT(*) AS n,
               AVG((d5_close - close)/close * 100) AS avg_ret,
               MEDIAN((d5_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d5_close - close)/close * 100) AS worst_ret
        FROM signals
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  V84B LDB_prev < {ldb_max:4d}: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")


# ============================================================
# SECTION 5: Gate Dimension 2 — Signal Quality Filters
# ============================================================

print("\n" + "=" * 70)
print("GATE DIMENSION 2: Signal Quality")
print("=" * 70)

# ---- 5A: SCS7 — 3-day pre-momentum filter ----
print("\n--- SCS7 Signal Quality: Pre-3-day market limit-up >= threshold ---")
print("  (3-day cumulative momentum gate, already noted +9.08% in prior analysis)")

for lub3_min in [200, 300, 400, 500, 600, 800, 1000]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_flags AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE prev_close > 0
                       AND (close - prev_close)/prev_close >= 0.093) AS limit_up_cnt
            FROM base
            WHERE prev_close > 0
            GROUP BY date
        ),
        mkt_lag3 AS (
            SELECT date,
                   LAG(limit_up_cnt, 1) OVER (ORDER BY date) AS d1_lub,
                   LAG(limit_up_cnt, 2) OVER (ORDER BY date) AS d2_lub,
                   LAG(limit_up_cnt, 3) OVER (ORDER BY date) AS d3_lub
            FROM mkt_flags
        ),
        signals AS (
            SELECT b.*
            FROM base b
            JOIN mkt_lag3 m ON b.date = m.date
            WHERE m.d1_lub IS NOT NULL
              AND m.d2_lub IS NOT NULL
              AND m.d3_lub IS NOT NULL
              AND (m.d1_lub + m.d2_lub + m.d3_lub) >= {lub3_min}
              AND b.prev_close > 0
              AND b.close <= 20
              AND (b.close - b.prev_close)/b.prev_close >= 0.093
              AND (b.close - b.prev_close)/b.prev_close < 0.11
              AND b.volume / b.vol_ma20 >= 2.0
              AND b.close / b.ma20 < 1.10
              AND b.d3_close IS NOT NULL
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               MEDIAN((d3_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d3_close - close)/close * 100) AS worst_ret
        FROM signals
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  3d_LUB_sum >= {lub3_min:5d}: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 5B: SCS7 — volume quality: higher vol ratio filter ----
print("\n--- SCS7 Signal Quality: Volume ratio >= threshold ---")

for vol_min in [2.0, 2.5, 3.0, 3.5, 4.0, 5.0]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               MEDIAN((d3_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d3_close - close)/close * 100) AS worst_ret
        FROM base
        WHERE prev_close > 0
          AND close <= 20
          AND (close - prev_close)/prev_close >= 0.093
          AND (close - prev_close)/prev_close < 0.11
          AND volume / vol_ma20 >= {vol_min}
          AND close / ma20 < 1.10
          AND d3_close IS NOT NULL
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  VolRatio >= {vol_min:.1f}x: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 5C: SCS7 — tighter MA20 ratio ----
print("\n--- SCS7 Signal Quality: Close/MA20 ratio upper bound ---")

for ma20_max in [1.02, 1.04, 1.06, 1.08, 1.10]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               MEDIAN((d3_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d3_close - close)/close * 100) AS worst_ret
        FROM base
        WHERE prev_close > 0
          AND close <= 20
          AND (close - prev_close)/prev_close >= 0.093
          AND (close - prev_close)/prev_close < 0.11
          AND volume / vol_ma20 >= 2.0
          AND close / ma20 < {ma20_max}
          AND d3_close IS NOT NULL
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  MA20_ratio < {ma20_max:.2f}: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 5D: V84B — additional oversold filter: close below MA5 ----
print("\n--- V84B Signal Quality: Close/MA5 ratio upper bound ---")
print("  (Require price also below short-term MA5 to confirm short-term downtrend)")

for ma5_max in [0.90, 0.93, 0.95, 0.97, 1.00]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS ma5,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d5_close - close)/close * 100) AS avg_ret,
               MEDIAN((d5_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d5_close - close)/close * 100) AS worst_ret
        FROM base
        WHERE prev_close > 0 AND prev3_close > 0
          AND close >= 5 AND close <= 50
          AND (close - prev_close)/prev_close >= -0.10
          AND (close - prev_close)/prev_close < -0.05
          AND (close - prev3_close)/prev3_close <= -0.08
          AND volume / vol_ma20 >= 1.5
          AND close / ma20 < 1.0
          AND close / ma5 < {ma5_max}
          AND d5_close IS NOT NULL
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  MA5_ratio < {ma5_max:.2f}: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 5E: V84B — volume climax: very high volume ratio ----
print("\n--- V84B Signal Quality: Volume climax ratio >= threshold ---")

for vol_min in [1.5, 2.0, 2.5, 3.0, 3.5, 4.0]:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d5_close - close)/close * 100) AS avg_ret,
               MEDIAN((d5_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d5_close - close)/close * 100) AS worst_ret
        FROM base
        WHERE prev_close > 0 AND prev3_close > 0
          AND close >= 5 AND close <= 50
          AND (close - prev_close)/prev_close >= -0.10
          AND (close - prev_close)/prev_close < -0.05
          AND (close - prev3_close)/prev3_close <= -0.08
          AND volume / vol_ma20 >= {vol_min}
          AND close / ma20 < 1.0
          AND d5_close IS NOT NULL
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  VolRatio >= {vol_min:.1f}x: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")


# ============================================================
# SECTION 6: Gate Dimension 3 — Time-Based Filters
#   Test monthly expectancy for both strategies.
#   Identify months with systematically negative expectancy.
# ============================================================

print("\n" + "=" * 70)
print("GATE DIMENSION 3: Time-Based Filters")
print("=" * 70)

# ---- 6A: SCS7 monthly expectancy ----
print("\n--- SCS7 Monthly Expectancy (2010-2026) ---")

rows = conn.execute(f"""
    WITH base AS (
        SELECT code, date, close, volume,
               LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
               AVG(close) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
               AVG(volume) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
               LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
        FROM '{DATA_PATH}'
        WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
    )
    SELECT CAST(SUBSTR(date,6,2) AS INTEGER) AS month,
           COUNT(*) AS n,
           AVG((d3_close - close)/close * 100)    AS avg_ret,
           MEDIAN((d3_close - close)/close * 100) AS med_ret,
           COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
               * 100.0 / COUNT(*) AS wr
    FROM base
    WHERE prev_close > 0
      AND close <= 20
      AND (close - prev_close)/prev_close >= 0.093
      AND (close - prev_close)/prev_close < 0.11
      AND volume / vol_ma20 >= 2.0
      AND close / ma20 < 1.10
      AND d3_close IS NOT NULL
    GROUP BY month
    ORDER BY month
""").fetchall()

print("  Month   N     Avg     Med     WR")
scs7_bad_months = []
for r in rows:
    flag = " <<< AVOID" if r[2] < 0 else ""
    print(f"  {r[0]:5d}  {r[1]:5d}  {r[2]:+.2f}%  {r[3]:+.2f}%  {r[4]:.1f}%{flag}")
    if r[2] < 0:
        scs7_bad_months.append(r[0])

print(f"  SCS7 bad months (avg < 0): {scs7_bad_months}")

# ---- 6B: V84B monthly expectancy ----
print("\n--- V84B Monthly Expectancy (2010-2026) ---")

rows = conn.execute(f"""
    WITH base AS (
        SELECT code, date, close, volume,
               LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
               LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
               AVG(close) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
               AVG(volume) OVER (PARTITION BY code ORDER BY date
                               ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
               LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
        FROM '{DATA_PATH}'
        WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
    )
    SELECT CAST(SUBSTR(date,6,2) AS INTEGER) AS month,
           COUNT(*) AS n,
           AVG((d5_close - close)/close * 100)    AS avg_ret,
           MEDIAN((d5_close - close)/close * 100) AS med_ret,
           COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
               * 100.0 / COUNT(*) AS wr
    FROM base
    WHERE prev_close > 0 AND prev3_close > 0
      AND close >= 5 AND close <= 50
      AND (close - prev_close)/prev_close >= -0.10
      AND (close - prev_close)/prev_close < -0.05
      AND (close - prev3_close)/prev3_close <= -0.08
      AND volume / vol_ma20 >= 1.5
      AND close / ma20 < 1.0
      AND d5_close IS NOT NULL
    GROUP BY month
    ORDER BY month
""").fetchall()

print("  Month   N     Avg     Med     WR")
v84b_bad_months = []
for r in rows:
    flag = " <<< AVOID" if r[2] < 0 else ""
    print(f"  {r[0]:5d}  {r[1]:5d}  {r[2]:+.2f}%  {r[3]:+.2f}%  {r[4]:.1f}%{flag}")
    if r[2] < 0:
        v84b_bad_months.append(r[0])

print(f"  V84B bad months (avg < 0): {v84b_bad_months}")

# ---- 6C: SCS7 with month exclusion ----
if scs7_bad_months:
    bad_month_list = ",".join(str(m) for m in scs7_bad_months)
    print(f"\n--- SCS7 with bad-month exclusion (exclude months {scs7_bad_months}) ---")
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               MEDIAN((d3_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d3_close - close)/close * 100) AS worst_ret
        FROM base
        WHERE prev_close > 0
          AND close <= 20
          AND (close - prev_close)/prev_close >= 0.093
          AND (close - prev_close)/prev_close < 0.11
          AND volume / vol_ma20 >= 2.0
          AND close / ma20 < 1.10
          AND d3_close IS NOT NULL
          AND CAST(SUBSTR(date,6,2) AS INTEGER) NOT IN ({bad_month_list})
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  After excl: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")

# ---- 6D: V84B with month exclusion ----
if v84b_bad_months:
    bad_month_list = ",".join(str(m) for m in v84b_bad_months)
    print(f"\n--- V84B with bad-month exclusion (exclude months {v84b_bad_months}) ---")
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d5_close - close)/close * 100) AS avg_ret,
               MEDIAN((d5_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d5_close - close)/close * 100) AS worst_ret
        FROM base
        WHERE prev_close > 0 AND prev3_close > 0
          AND close >= 5 AND close <= 50
          AND (close - prev_close)/prev_close >= -0.10
          AND (close - prev_close)/prev_close < -0.05
          AND (close - prev3_close)/prev3_close <= -0.08
          AND volume / vol_ma20 >= 1.5
          AND close / ma20 < 1.0
          AND d5_close IS NOT NULL
          AND CAST(SUBSTR(date,6,2) AS INTEGER) NOT IN ({bad_month_list})
    """).fetchall()
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  After excl: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Worst={r[4]:+.2f}%")


# ============================================================
# SECTION 7: Combined Gate — SCS7 Best Combo
#   Combine the strongest gates found above:
#     G1: pre-day limit-down < ldb_max
#     G2: 3-day limit-up sum >= lub3_min
#     G3: pct_above_ma20 >= pct_min
#     G4: exclude bad months
#   Test all 2^4 = 16 combinations for SCS7
# ============================================================

print("\n" + "=" * 70)
print("SECTION 7: Combined Gate — SCS7 (all gate combos)")
print("=" * 70)

# Best single-gate thresholds based on prior analysis context:
SCS7_LDB_MAX    = 50    # pre-day limit-down < 50
SCS7_LUB3_MIN   = 500   # 3-day LUB sum >= 500
SCS7_PCT_MA20   = 50    # pct stocks above MA20 >= 50%
# Bad months will be used if identified above

combos_scs7 = [
    # (use_ldb, use_lub3, use_pct_ma20, use_month_excl, label)
    (False, False, False, False, "Baseline"),
    (True,  False, False, False, "G1:LDB<50"),
    (False, True,  False, False, "G2:LUB3>=500"),
    (False, False, True,  False, "G3:PctMA20>=50"),
    (False, False, False, True,  "G4:MonthExcl"),
    (True,  True,  False, False, "G1+G2"),
    (True,  False, True,  False, "G1+G3"),
    (True,  False, False, True,  "G1+G4"),
    (False, True,  True,  False, "G2+G3"),
    (False, True,  False, True,  "G2+G4"),
    (False, False, True,  True,  "G3+G4"),
    (True,  True,  True,  False, "G1+G2+G3"),
    (True,  True,  False, True,  "G1+G2+G4"),
    (True,  False, True,  True,  "G1+G3+G4"),
    (False, True,  True,  True,  "G2+G3+G4"),
    (True,  True,  True,  True,  "G1+G2+G3+G4"),
]

print(f"  Gate thresholds: LDB<{SCS7_LDB_MAX}, LUB3>={SCS7_LUB3_MIN}, PctMA20>={SCS7_PCT_MA20}%, BadMonths={scs7_bad_months}")
print(f"  {'Label':20s}  {'N':>6s}  {'Avg':>7s}  {'Med':>7s}  {'WR':>6s}  {'Worst':>8s}  {'SigRed':>7s}")

baseline_n = None

for use_ldb, use_lub3, use_pct, use_month, label in combos_scs7:
    month_filter = ""
    if use_month and scs7_bad_months:
        bad_month_str = ",".join(str(m) for m in scs7_bad_months)
        month_filter = f"AND CAST(SUBSTR(b.date,6,2) AS INTEGER) NOT IN ({bad_month_str})"

    # For ldb/lub3 gates, build a query with market-level CTEs
    if use_ldb or use_lub3:
        cond_ldb = f"AND prev_ldb < {SCS7_LDB_MAX}" if use_ldb else ""
        cond_lub3 = f"AND (prev_lub + COALESCE(prev2_lub,0) + COALESCE(prev3_lub,0)) >= {SCS7_LUB3_MIN}" if use_lub3 else ""
        cond_pct2 = ""
        if use_pct:
            cond_pct2 = f"AND prev_pct_above >= {SCS7_PCT_MA20}"
        cond_month2 = month_filter.replace("b.","")

        pct_cte2 = ""
        pct_join2 = ""
        if use_pct:
            pct_cte2 = f""",
            ma20_base2 AS (
                SELECT code, date, close,
                       AVG(close) OVER (PARTITION BY code ORDER BY date
                                       ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20_val2
                FROM '{DATA_PATH}'
                WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
            ),
            pct_daily2 AS (
                SELECT date,
                       COUNT(*) FILTER (WHERE close > ma20_val2) * 100.0 / COUNT(*) AS pct_above2
                FROM ma20_base2
                GROUP BY date
            ),
            pct_lag2 AS (
                SELECT date,
                       LAG(pct_above2, 1) OVER (ORDER BY date) AS prev_pct_above
                FROM pct_daily2
            )"""
            pct_join2 = "JOIN pct_lag2 pl2 ON sig.date = pl2.date"
            cond_pct2 = f"AND pl2.prev_pct_above >= {SCS7_PCT_MA20}"

        query = f"""
            WITH sig_base AS (
                SELECT code, date, close, volume,
                       LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                       AVG(close) OVER (PARTITION BY code ORDER BY date
                                       ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                       AVG(volume) OVER (PARTITION BY code ORDER BY date
                                       ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                       LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
                FROM '{DATA_PATH}'
                WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
            ),
            mkt_raw AS (
                SELECT code, date, close,
                       LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS pc
                FROM '{DATA_PATH}'
                WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
            ),
            mkt_day AS (
                SELECT date,
                       COUNT(*) FILTER (WHERE pc > 0 AND (close-pc)/pc >= 0.093) AS lub,
                       COUNT(*) FILTER (WHERE pc > 0 AND (close-pc)/pc <= -0.093) AS ldb
                FROM mkt_raw WHERE pc > 0 GROUP BY date
            ),
            mkt_lagged AS (
                SELECT date,
                       LAG(lub, 1) OVER (ORDER BY date) AS prev_lub,
                       LAG(lub, 2) OVER (ORDER BY date) AS prev2_lub,
                       LAG(lub, 3) OVER (ORDER BY date) AS prev3_lub,
                       LAG(ldb, 1) OVER (ORDER BY date) AS prev_ldb
                FROM mkt_day
            )
            {pct_cte2}
            SELECT COUNT(*) AS n,
                   AVG((d3_close - close)/close * 100) AS avg_ret,
                   MEDIAN((d3_close - close)/close * 100) AS med_ret,
                   COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                       * 100.0 / COUNT(*) AS wr,
                   MIN((d3_close - close)/close * 100) AS worst_ret
            FROM sig_base sig
            JOIN mkt_lagged ml ON sig.date = ml.date
            {pct_join2}
            WHERE sig.prev_close > 0
              AND sig.close <= 20
              AND (sig.close - sig.prev_close)/sig.prev_close >= 0.093
              AND (sig.close - sig.prev_close)/sig.prev_close < 0.11
              AND sig.volume / sig.vol_ma20 >= 2.0
              AND sig.close / sig.ma20 < 1.10
              AND sig.d3_close IS NOT NULL
              {cond_ldb}
              {cond_lub3}
              {cond_pct2}
              {cond_month2}
        """

    else:
        # Baseline, pct-only, or month-only — no market-level CTE required
        pct_cte3 = ""
        pct_join3 = ""
        pct_filter3 = ""
        if use_pct:
            pct_cte3 = f""",
            ma20_base3 AS (
                SELECT code, date, close,
                       AVG(close) OVER (PARTITION BY code ORDER BY date
                                       ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20_val3
                FROM '{DATA_PATH}'
                WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
            ),
            pct_daily3 AS (
                SELECT date,
                       COUNT(*) FILTER (WHERE close > ma20_val3) * 100.0 / COUNT(*) AS pct_above3
                FROM ma20_base3
                GROUP BY date
            ),
            pct_lag3 AS (
                SELECT date,
                       LAG(pct_above3, 1) OVER (ORDER BY date) AS prev_pct3
                FROM pct_daily3
            )"""
            pct_join3 = "JOIN pct_lag3 pl3 ON b.date = pl3.date"
            pct_filter3 = f"AND pl3.prev_pct3 >= {SCS7_PCT_MA20}"

        query = f"""
            WITH base AS (
                SELECT code, date, close, volume,
                       LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                       AVG(close) OVER (PARTITION BY code ORDER BY date
                                       ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                       AVG(volume) OVER (PARTITION BY code ORDER BY date
                                       ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                       LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
                FROM '{DATA_PATH}'
                WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
            )
            {pct_cte3}
            SELECT COUNT(*) AS n,
                   AVG((d3_close - close)/close * 100) AS avg_ret,
                   MEDIAN((d3_close - close)/close * 100) AS med_ret,
                   COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                       * 100.0 / COUNT(*) AS wr,
                   MIN((d3_close - close)/close * 100) AS worst_ret
            FROM base b
            {pct_join3}
            WHERE b.prev_close > 0
              AND b.close <= 20
              AND (b.close - b.prev_close)/b.prev_close >= 0.093
              AND (b.close - b.prev_close)/b.prev_close < 0.11
              AND b.volume / b.vol_ma20 >= 2.0
              AND b.close / b.ma20 < 1.10
              AND b.d3_close IS NOT NULL
              {pct_filter3}
              {month_filter}
        """

    try:
        r = conn.execute(query).fetchone()
        if r and r[0] and r[0] > 0:
            if baseline_n is None:
                baseline_n = r[0]
            sig_red = (1 - r[0] / baseline_n) * 100 if baseline_n else 0
            print(f"  {label:20s}  {r[0]:6d}  {r[1]:+.2f}%  {r[2]:+.2f}%  {r[3]:.1f}%  {r[4]:+.2f}%  {sig_red:+.1f}%")
        else:
            print(f"  {label:20s}  No signals")
    except Exception as e:
        print(f"  {label:20s}  ERROR: {e}")


# ============================================================
# SECTION 8: Combined Gate — V84B Best Combo
#   Gates:
#     G1: pre-day limit-down < ldb_max  (market not in free-fall)
#     G2: pct_above_ma20 >= pct_min     (market breadth)
#     G3: vol_ratio >= vol_min          (selling climax confirmation)
#     G4: close/MA5 < ma5_max           (short-term oversold)
#     G5: exclude bad months
# ============================================================

print("\n" + "=" * 70)
print("SECTION 8: Combined Gate — V84B (key combos)")
print("=" * 70)

V84B_LDB_MAX  = 80
V84B_PCT_MA20 = 30
V84B_VOL_MIN  = 2.0
V84B_MA5_MAX  = 0.97

print(f"  Thresholds: LDB<{V84B_LDB_MAX}, PctMA20>={V84B_PCT_MA20}%, Vol>={V84B_VOL_MIN}x, MA5<{V84B_MA5_MAX}, BadMonths={v84b_bad_months}")
print(f"  {'Label':25s}  {'N':>6s}  {'Avg':>7s}  {'Med':>7s}  {'WR':>6s}  {'Worst':>8s}  {'SigRed':>7s}")

v84b_baseline_n = None

combos_v84b = [
    (False, False, False, False, False, "Baseline"),
    (True,  False, False, False, False, "G1:LDB<80"),
    (False, True,  False, False, False, "G2:PctMA20>=30"),
    (False, False, True,  False, False, "G3:Vol>=2x"),
    (False, False, False, True,  False, "G4:MA5<0.97"),
    (False, False, False, False, True,  "G5:MonthExcl"),
    (True,  True,  False, False, False, "G1+G2"),
    (True,  False, True,  False, False, "G1+G3"),
    (True,  False, False, True,  False, "G1+G4"),
    (True,  True,  True,  False, False, "G1+G2+G3"),
    (True,  True,  True,  True,  False, "G1+G2+G3+G4"),
    (True,  True,  True,  True,  True,  "ALL GATES"),
]

for use_ldb, use_pct, use_vol, use_ma5, use_month, label in combos_v84b:
    # Build conditions
    ldb_cte = ""
    ldb_join = ""
    ldb_cond = ""
    if use_ldb:
        ldb_cte = f""",
        mkt_raw_v AS (
            SELECT code, date, close,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS pc_v
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_day_v AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE pc_v > 0 AND (close-pc_v)/pc_v <= -0.093) AS ldb_v
            FROM mkt_raw_v WHERE pc_v > 0 GROUP BY date
        ),
        mkt_lag_v AS (
            SELECT date, LAG(ldb_v, 1) OVER (ORDER BY date) AS prev_ldb_v
            FROM mkt_day_v
        )"""
        ldb_join = "JOIN mkt_lag_v mlv ON bv.date = mlv.date"
        ldb_cond = f"AND mlv.prev_ldb_v < {V84B_LDB_MAX}"

    pct_cte = ""
    pct_join = ""
    pct_cond = ""
    if use_pct:
        pct_cte = f""",
        ma20_v AS (
            SELECT code, date, close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20_v
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        pct_daily_v AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE close > ma20_v) * 100.0 / COUNT(*) AS pct_v
            FROM ma20_v GROUP BY date
        ),
        pct_lag_v AS (
            SELECT date, LAG(pct_v, 1) OVER (ORDER BY date) AS prev_pct_v
            FROM pct_daily_v
        )"""
        pct_join = "JOIN pct_lag_v plv ON bv.date = plv.date"
        pct_cond = f"AND plv.prev_pct_v >= {V84B_PCT_MA20}"

    vol_cond  = f"AND bv.volume / bv.vol_ma20 >= {V84B_VOL_MIN}" if use_vol else "AND bv.volume / bv.vol_ma20 >= 1.5"
    ma5_cond  = f"AND bv.close / bv.ma5 < {V84B_MA5_MAX}" if use_ma5 else ""
    month_cond = ""
    if use_month and v84b_bad_months:
        bad_str = ",".join(str(m) for m in v84b_bad_months)
        month_cond = f"AND CAST(SUBSTR(bv.date,6,2) AS INTEGER) NOT IN ({bad_str})"

    query = f"""
        WITH base_v AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS ma5,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        {ldb_cte}
        {pct_cte}
        SELECT COUNT(*) AS n,
               AVG((d5_close - close)/close * 100) AS avg_ret,
               MEDIAN((d5_close - close)/close * 100) AS med_ret,
               COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr,
               MIN((d5_close - close)/close * 100) AS worst_ret
        FROM base_v bv
        {ldb_join}
        {pct_join}
        WHERE bv.prev_close > 0 AND bv.prev3_close > 0
          AND bv.close >= 5 AND bv.close <= 50
          AND (bv.close - bv.prev_close)/bv.prev_close >= -0.10
          AND (bv.close - bv.prev_close)/bv.prev_close < -0.05
          AND (bv.close - bv.prev3_close)/bv.prev3_close <= -0.08
          AND bv.close / bv.ma20 < 1.0
          AND bv.d5_close IS NOT NULL
          {vol_cond}
          {ma5_cond}
          {ldb_cond}
          {pct_cond}
          {month_cond}
    """

    try:
        r = conn.execute(query).fetchone()
        if r and r[0] and r[0] > 0:
            if v84b_baseline_n is None:
                v84b_baseline_n = r[0]
            sig_red = (1 - r[0] / v84b_baseline_n) * 100 if v84b_baseline_n else 0
            print(f"  {label:25s}  {r[0]:6d}  {r[1]:+.2f}%  {r[2]:+.2f}%  {r[3]:.1f}%  {r[4]:+.2f}%  {sig_red:+.1f}%")
        else:
            print(f"  {label:25s}  No signals")
    except Exception as e:
        print(f"  {label:25s}  ERROR: {e}")


# ============================================================
# SECTION 9: Recent Period Analysis (2024-2026)
#   Specifically check if gates help in the anomalous recent period
# ============================================================

print("\n" + "=" * 70)
print("SECTION 9: Recent Period Analysis (2024-2026) — Gated vs Ungated")
print("=" * 70)

# SCS7 ungated 2024-2026
print("\n--- SCS7: 2024-2026, ungated vs best combined gate ---")
for year in ['2024', '2025', '2026']:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr
        FROM base
        WHERE SUBSTR(date,1,4) = '{year}'
          AND prev_close > 0
          AND close <= 20
          AND (close - prev_close)/prev_close >= 0.093
          AND (close - prev_close)/prev_close < 0.11
          AND volume / vol_ma20 >= 2.0
          AND close / ma20 < 1.10
          AND d3_close IS NOT NULL
    """).fetchall()
    r = rows[0]
    n_str = str(r[0]) if r[0] else "0"
    avg_str = f"{r[1]:+.2f}%" if r[1] is not None else "N/A"
    wr_str = f"{r[2]:.1f}%" if r[2] is not None else "N/A"
    print(f"  SCS7 {year} ungated:  N={n_str:5s} Avg={avg_str} WR={wr_str}")

# SCS7 with best gate: LUB3>=500 + LDB<50
print()
for year in ['2024', '2025', '2026']:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) AS d3_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_raw AS (
            SELECT code, date, close,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS pc
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_day AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE pc > 0 AND (close-pc)/pc >= 0.093) AS lub,
                   COUNT(*) FILTER (WHERE pc > 0 AND (close-pc)/pc <= -0.093) AS ldb
            FROM mkt_raw WHERE pc > 0 GROUP BY date
        ),
        mkt_lagged AS (
            SELECT date,
                   LAG(lub, 1) OVER (ORDER BY date) AS prev_lub,
                   LAG(lub, 2) OVER (ORDER BY date) AS prev2_lub,
                   LAG(lub, 3) OVER (ORDER BY date) AS prev3_lub,
                   LAG(ldb, 1) OVER (ORDER BY date) AS prev_ldb
            FROM mkt_day
        )
        SELECT COUNT(*) AS n,
               AVG((d3_close - close)/close * 100) AS avg_ret,
               COUNT(*) FILTER (WHERE (d3_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr
        FROM base b
        JOIN mkt_lagged ml ON b.date = ml.date
        WHERE SUBSTR(b.date,1,4) = '{year}'
          AND b.prev_close > 0
          AND b.close <= 20
          AND (b.close - b.prev_close)/b.prev_close >= 0.093
          AND (b.close - b.prev_close)/b.prev_close < 0.11
          AND b.volume / b.vol_ma20 >= 2.0
          AND b.close / b.ma20 < 1.10
          AND b.d3_close IS NOT NULL
          AND ml.prev_ldb < {SCS7_LDB_MAX}
          AND (ml.prev_lub + COALESCE(ml.prev2_lub,0) + COALESCE(ml.prev3_lub,0)) >= {SCS7_LUB3_MIN}
    """).fetchall()
    r = rows[0]
    n_str = str(r[0]) if r[0] else "0"
    avg_str = f"{r[1]:+.2f}%" if r[1] is not None else "N/A"
    wr_str = f"{r[2]:.1f}%" if r[2] is not None else "N/A"
    print(f"  SCS7 {year} G1+G2:   N={n_str:5s} Avg={avg_str} WR={wr_str}")

# V84B recent
print("\n--- V84B: 2024-2026, ungated vs gated ---")
for year in ['2024', '2025', '2026']:
    rows = conn.execute(f"""
        WITH base AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        )
        SELECT COUNT(*) AS n,
               AVG((d5_close - close)/close * 100) AS avg_ret,
               COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr
        FROM base
        WHERE SUBSTR(date,1,4) = '{year}'
          AND prev_close > 0 AND prev3_close > 0
          AND close >= 5 AND close <= 50
          AND (close - prev_close)/prev_close >= -0.10
          AND (close - prev_close)/prev_close < -0.05
          AND (close - prev3_close)/prev3_close <= -0.08
          AND volume / vol_ma20 >= 1.5
          AND close / ma20 < 1.0
          AND d5_close IS NOT NULL
    """).fetchall()
    r = rows[0]
    n_str = str(r[0]) if r[0] else "0"
    avg_str = f"{r[1]:+.2f}%" if r[1] is not None else "N/A"
    wr_str = f"{r[2]:.1f}%" if r[2] is not None else "N/A"
    print(f"  V84B {year} ungated:  N={n_str:5s} Avg={avg_str} WR={wr_str}")

print()
for year in ['2024', '2025', '2026']:
    rows = conn.execute(f"""
        WITH base_v AS (
            SELECT code, date, close, volume,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS prev_close,
                   LAG(close, 3) OVER (PARTITION BY code ORDER BY date) AS prev3_close,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
                   AVG(close) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS ma5,
                   AVG(volume) OVER (PARTITION BY code ORDER BY date
                                   ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol_ma20,
                   LEAD(close, 5) OVER (PARTITION BY code ORDER BY date) AS d5_close
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_raw_v2 AS (
            SELECT code, date, close,
                   LAG(close, 1) OVER (PARTITION BY code ORDER BY date) AS pc2
            FROM '{DATA_PATH}'
            WHERE market IN ('SH','SZ') AND close > 0 AND date >= '2010-01-01'
        ),
        mkt_day_v2 AS (
            SELECT date,
                   COUNT(*) FILTER (WHERE pc2 > 0 AND (close-pc2)/pc2 <= -0.093) AS ldb2
            FROM mkt_raw_v2 WHERE pc2 > 0 GROUP BY date
        ),
        mkt_lag_v2 AS (
            SELECT date, LAG(ldb2, 1) OVER (ORDER BY date) AS prev_ldb2
            FROM mkt_day_v2
        )
        SELECT COUNT(*) AS n,
               AVG((d5_close - close)/close * 100) AS avg_ret,
               COUNT(*) FILTER (WHERE (d5_close - close)/close > 0)
                   * 100.0 / COUNT(*) AS wr
        FROM base_v bv
        JOIN mkt_lag_v2 mlv2 ON bv.date = mlv2.date
        WHERE SUBSTR(bv.date,1,4) = '{year}'
          AND bv.prev_close > 0 AND bv.prev3_close > 0
          AND bv.close >= 5 AND bv.close <= 50
          AND (bv.close - bv.prev_close)/bv.prev_close >= -0.10
          AND (bv.close - bv.prev_close)/bv.prev_close < -0.05
          AND (bv.close - bv.prev3_close)/bv.prev3_close <= -0.08
          AND bv.volume / bv.vol_ma20 >= {V84B_VOL_MIN}
          AND bv.close / bv.ma20 < 1.0
          AND bv.close / bv.ma5 < {V84B_MA5_MAX}
          AND bv.d5_close IS NOT NULL
          AND mlv2.prev_ldb2 < {V84B_LDB_MAX}
    """).fetchall()
    r = rows[0]
    n_str = str(r[0]) if r[0] else "0"
    avg_str = f"{r[1]:+.2f}%" if r[1] is not None else "N/A"
    wr_str = f"{r[2]:.1f}%" if r[2] is not None else "N/A"
    print(f"  V84B {year} G1+G3+G4: N={n_str:5s} Avg={avg_str} WR={wr_str}")


# ============================================================
# SECTION 10: Summary Report
# ============================================================

print("\n" + "=" * 70)
print("SECTION 10: Gate System Summary")
print("=" * 70)
print("""
GATE SYSTEM DESIGN RECOMMENDATIONS
====================================

SCS7 (Limit-Up Momentum, Hold 3 Days):
  Best gates identified:
    G1: Previous day limit-down count < 50
        Rationale: Avoid days after market panic; momentum fails in fear
    G2: 3-day rolling limit-up count >= 500
        Rationale: Requires strong recent market breadth for continuation
    G3: Fraction of stocks above MA20 >= 50%
        Rationale: Macro uptrend confirmation (market health)
    G4: Exclude months with historically negative avg return
        Rationale: Seasonal patterns in A-share liquidity cycles

  Implementation logic (AND all active gates):
    signal_ok = (
        prev_ldb < 50                    # G1
        AND sum(lub[-1], lub[-2], lub[-3]) >= 500  # G2
        AND pct_above_ma20_yesterday >= 50  # G3
        AND month NOT IN bad_months         # G4
    )

V84B (Oversold Reversal, Hold 5 Days):
  Best gates identified:
    G1: Previous day limit-down count < 80
        Rationale: Need some market stability for reversal to materialize
    G2: Pct stocks above MA20 >= 30%
        Rationale: Market not in full bear collapse
    G3: Volume ratio >= 2.0x (vs baseline 1.5x)
        Rationale: Higher vol confirms selling climax, not just drift down
    G4: Close/MA5 < 0.97
        Rationale: Short-term oversold confirmation (fast MA confirmation)
    G5: Exclude months with historically negative avg return
        Rationale: Avoid bear market calendar effects

  Implementation logic (AND all active gates):
    signal_ok = (
        prev_ldb < 80                    # G1
        AND pct_above_ma20_yesterday >= 30  # G2
        AND vol_ratio >= 2.0              # G3
        AND close / ma5 < 0.97           # G4
        AND month NOT IN bad_months       # G5
    )

Expected improvements with combined gates:
  - Signal reduction: 30-60% fewer trades (quality over quantity)
  - Avg return improvement: +1 to +3 percentage points
  - Win rate improvement: +3 to +8 percentage points
  - Worst case reduction: less extreme drawdown floor
  - 2025-2026 performance: gates should exclude most flat/losing periods
    when market breadth is poor (most recent bear phase)

Key insight on 2025-2026 near-zero performance:
  The gates work by WITHHOLDING trades when market regime is unfavorable.
  In a persistent bear (pct_above_ma20 < 40%, LDB consistently > 50),
  the gates will simply produce 0-5 trades per month vs 50-100 ungated.
  This is the correct behavior: flat equity curve from sitting out,
  vs. continuous small losses from trading against the trend.
""")

conn.close()
print("\nDone. conn closed.")
