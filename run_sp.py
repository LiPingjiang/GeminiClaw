import duckdb
conn = duckdb.connect("/opt/dragon-stock/data/stock_monitor_readonly.duckdb", read_only=True)

print("="*70)
print("STRONG PULLBACK — Fast DuckDB Batch Query")
print("="*70)

variants = [
    ("SP1_touch_ma20", 0.98, 1.02, 0.9, 15, 3),
    ("SP2_pullback_5pct", 0.95, 1.00, 1.0, 15, 3),
    ("SP3_pullback_10pct", 0.90, 1.00, 1.0, 15, 3),
    ("SP4_pullback_5pct_vol_low", 0.95, 1.00, 0.8, 15, 3),
    ("SP5_pullback_8pct", 0.92, 1.00, 1.0, 15, 3),
    ("SP6_touch_ma20_5d", 0.98, 1.02, 1.0, 20, 5),
    ("SP7_pullback_5pct_5d", 0.95, 1.00, 1.0, 20, 5),
    ("SP8_pullback_3pct", 0.97, 1.00, 1.0, 10, 3),
    ("SP9_pullback_7pct_vol_low", 0.93, 1.00, 0.8, 15, 3),
    ("SP10_deep_pullback", 0.90, 0.98, 1.0, 20, 3),
]

for vname, close_min_ma20, close_max_ma20, vol_max, trend_days, hold_days in variants:
    rows = conn.execute(f"""
        WITH daily AS (
          SELECT code, date, close, high, volume,
                 AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
                 AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) as ma60
          FROM daily_kline
          WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
        ),
        daily2 AS (
          SELECT code, date, close, high, volume, ma20, ma60,
                 MAX(high) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as high_20d,
                 AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
                 LEAD(close, {hold_days}) OVER (PARTITION BY code ORDER BY date) as fwd_close,
                 SUM(CASE WHEN close > ma20 AND ma20 > ma60 THEN 1 ELSE 0 END) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN {trend_days} PRECEDING AND 1 PRECEDING) as trend_count
          FROM daily
        )
        SELECT 
          COUNT(*) as n,
          AVG((fwd_close - close) / close * 100) as avg_ret,
          MEDIAN((fwd_close - close) / close * 100) as med_ret,
          COUNT(*) FILTER (WHERE (fwd_close - close) / close > 0) * 100.0 / COUNT(*) as wr,
          MAX((fwd_close - close) / close * 100) as max_ret,
          MIN((fwd_close - close) / close * 100) as min_ret
        FROM daily2
        WHERE close > ma20 AND ma20 > ma60
          AND close / ma20 >= {close_min_ma20} AND close / ma20 <= {close_max_ma20}
          AND volume / vol_ma20 <= {vol_max}
          AND close < high_20d * 0.98
          AND trend_count >= {trend_days} - 1
          AND fwd_close IS NOT NULL
    """).fetchall()
    
    r = rows[0]
    if r[0] is None or r[0] == 0:
        print(f"{vname:18s} No signals")
    else:
        print(f"{vname:18s} N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Max={r[4]:+.2f}% Min={r[5]:+.2f}%")

conn.close()
