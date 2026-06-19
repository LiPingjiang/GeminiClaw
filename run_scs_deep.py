import duckdb
conn = duckdb.connect("/opt/dragon-stock/data/stock_monitor_readonly.duckdb", read_only=True)

print("="*70)
print("SCS DEEP SQUEEZE — Annual Breakdown + Parameter Fine-Tuning")
print("="*70)

# --- Annual breakdown for SCS7 (limitup) ---
print("\n--- SCS7 Limit-Up Annual Breakdown ---")
rows = conn.execute("""
    WITH daily AS (
      SELECT code, date, close, open, volume,
             LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
             AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
             AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
             LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) as d3_close
      FROM daily_kline
      WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
    )
    SELECT 
      SUBSTR(date, 1, 4) as year,
      COUNT(*) as n,
      AVG((d3_close - close) / close * 100) as avg,
      MEDIAN((d3_close - close) / close * 100) as med,
      COUNT(*) FILTER (WHERE (d3_close - close) / close > 0) * 100.0 / COUNT(*) as wr
    FROM daily
    WHERE prev_close > 0 AND close <= 20
      AND (close - prev_close) / prev_close >= 0.093 AND (close - prev_close) / prev_close < 0.11
      AND volume / vol_ma20 >= 2.0
      AND d3_close IS NOT NULL
    GROUP BY year
    ORDER BY year
""").fetchall()

for r in rows:
    print(f"  {r[0]} N={r[1]:5d} Avg={r[2]:+.2f}% Med={r[3]:+.2f}% WR={r[4]:.1f}%")

# --- SCS2 Low-Vol Annual Breakdown ---
print("\n--- SCS2 Low-Vol Annual Breakdown ---")
rows = conn.execute("""
    WITH daily AS (
      SELECT code, date, close, open, volume,
             LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
             AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
             AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
             LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) as d3_close
      FROM daily_kline
      WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
    )
    SELECT 
      SUBSTR(date, 1, 4) as year,
      COUNT(*) as n,
      AVG((d3_close - close) / close * 100) as avg,
      MEDIAN((d3_close - close) / close * 100) as med,
      COUNT(*) FILTER (WHERE (d3_close - close) / close > 0) * 100.0 / COUNT(*) as wr
    FROM daily
    WHERE prev_close > 0 AND close <= 20
      AND (close - prev_close) / prev_close >= 0.05 AND (close - prev_close) / prev_close < 0.093
      AND volume / vol_ma20 >= 1.5
      AND d3_close IS NOT NULL
    GROUP BY year
    ORDER BY year
""").fetchall()

for r in rows:
    print(f"  {r[0]} N={r[1]:5d} Avg={r[2]:+.2f}% Med={r[3]:+.2f}% WR={r[4]:.1f}%")

# --- SCS7 Parameter Fine-Tuning ---
print("\n--- SCS7 Limit-Up Parameter Fine-Tuning ---")
variants = [
    ("L1_base", 20, 2.0, 0.093, 0.11, 1.25),
    ("L2_price_15", 15, 2.0, 0.093, 0.11, 1.25),
    ("L3_price_10", 10, 2.0, 0.093, 0.11, 1.25),
    ("L4_price_30", 30, 2.0, 0.093, 0.11, 1.25),
    ("L5_vol_1.5x", 20, 1.5, 0.093, 0.11, 1.25),
    ("L6_vol_3x", 20, 3.0, 0.093, 0.11, 1.25),
    ("L7_vol_4x", 20, 4.0, 0.093, 0.11, 1.25),
    ("L8_gain_8pct", 20, 2.0, 0.08, 0.11, 1.25),
    ("L9_gain_5pct", 20, 2.0, 0.05, 0.11, 1.25),
    ("L10_no_ma20_filter", 20, 2.0, 0.093, 0.11, 999),
    ("L11_tight_ma20", 20, 2.0, 0.093, 0.11, 1.10),
    ("L12_5d_hold", 20, 2.0, 0.093, 0.11, 1.25),
    ("L13_1d_hold", 20, 2.0, 0.093, 0.11, 1.25),
    ("L14_2d_hold", 20, 2.0, 0.093, 0.11, 1.25),
    ("L15_vol_2.5x", 20, 2.5, 0.093, 0.11, 1.25),
]

for vname, price_max, vol_min, gain_min, gain_max, max_ma20_mult in variants:
    hold_days = 3
    if vname == "L12_5d_hold":
        hold_days = 5
    elif vname == "L13_1d_hold":
        hold_days = 1
    elif vname == "L14_2d_hold":
        hold_days = 2
    
    rows = conn.execute(f"""
        WITH daily AS (
          SELECT code, date, close, open, volume,
                 LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
                 AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
                 AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
                 LEAD(close, {hold_days}) OVER (PARTITION BY code ORDER BY date) as fwd_close
          FROM daily_kline
          WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
        )
        SELECT 
          COUNT(*) as n,
          AVG((fwd_close - close) / close * 100) as avg,
          MEDIAN((fwd_close - close) / close * 100) as med,
          COUNT(*) FILTER (WHERE (fwd_close - close) / close > 0) * 100.0 / COUNT(*) as wr,
          MAX((fwd_close - close) / close * 100) as max_ret,
          MIN((fwd_close - close) / close * 100) as min_ret
        FROM daily
        WHERE prev_close > 0 AND close <= {price_max}
          AND (close - prev_close) / prev_close >= {gain_min} AND (close - prev_close) / prev_close < {gain_max}
          AND volume / vol_ma20 >= {vol_min}
          AND fwd_close IS NOT NULL
          AND (close / ma20 < {max_ma20_mult} OR {max_ma20_mult} >= 100)
    """).fetchall()
    
    r = rows[0]
    if r[0] is None or r[0] == 0:
        print(f"{vname:15s} No signals")
    else:
        print(f"{vname:15s} N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Max={r[4]:+.2f}% Min={r[5]:+.2f}%")

# --- SCS2 Parameter Fine-Tuning ---
print("\n--- SCS2 Low-Vol Parameter Fine-Tuning ---")
variants2 = [
    ("V1_base", 20, 1.5, 0.05, 0.093, 1.25, 3),
    ("V2_price_15", 15, 1.5, 0.05, 0.093, 1.25, 3),
    ("V3_price_10", 10, 1.5, 0.05, 0.093, 1.25, 3),
    ("V4_price_30", 30, 1.5, 0.05, 0.093, 1.25, 3),
    ("V5_vol_1.0x", 20, 1.0, 0.05, 0.093, 1.25, 3),
    ("V6_vol_2.0x", 20, 2.0, 0.05, 0.093, 1.25, 3),
    ("V7_vol_2.5x", 20, 2.5, 0.05, 0.093, 1.25, 3),
    ("V8_gain_3pct", 20, 1.5, 0.03, 0.093, 1.25, 3),
    ("V9_gain_8pct", 20, 1.5, 0.08, 0.093, 1.25, 3),
    ("V10_no_ma20_filter", 20, 1.5, 0.05, 0.093, 999, 3),
    ("V11_tight_ma20", 20, 1.5, 0.05, 0.093, 1.10, 3),
    ("V12_5d_hold", 20, 1.5, 0.05, 0.093, 1.25, 5),
    ("V13_1d_hold", 20, 1.5, 0.05, 0.093, 1.25, 1),
    ("V14_2d_hold", 20, 1.5, 0.05, 0.093, 1.25, 2),
]

for vname, price_max, vol_min, gain_min, gain_max, max_ma20_mult, hold_days in variants2:
    rows = conn.execute(f"""
        WITH daily AS (
          SELECT code, date, close, open, volume,
                 LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
                 AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
                 AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
                 LEAD(close, {hold_days}) OVER (PARTITION BY code ORDER BY date) as fwd_close
          FROM daily_kline
          WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
        )
        SELECT 
          COUNT(*) as n,
          AVG((fwd_close - close) / close * 100) as avg,
          MEDIAN((fwd_close - close) / close * 100) as med,
          COUNT(*) FILTER (WHERE (fwd_close - close) / close > 0) * 100.0 / COUNT(*) as wr,
          MAX((fwd_close - close) / close * 100) as max_ret,
          MIN((fwd_close - close) / close * 100) as min_ret
        FROM daily
        WHERE prev_close > 0 AND close <= {price_max}
          AND (close - prev_close) / prev_close >= {gain_min} AND (close - prev_close) / prev_close < {gain_max}
          AND volume / vol_ma20 >= {vol_min}
          AND fwd_close IS NOT NULL
          AND (close / ma20 < {max_ma20_mult} OR {max_ma20_mult} >= 100)
    """).fetchall()
    
    r = rows[0]
    if r[0] is None or r[0] == 0:
        print(f"{vname:15s} No signals")
    else:
        print(f"{vname:15s} N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Max={r[4]:+.2f}% Min={r[5]:+.2f}%")

conn.close()
