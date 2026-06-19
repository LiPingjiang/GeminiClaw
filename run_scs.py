import duckdb
conn = duckdb.connect("/opt/dragon-stock/data/stock_monitor_readonly.duckdb", read_only=True)

print("="*70)
print("SMALL-CAP SURGE — Fast DuckDB Batch Query")
print("="*70)

variants = [
    ("SCS1_base", 20, 2.0, 0.05, 0.093, 1.25),
    ("SCS2_low_vol", 20, 1.5, 0.05, 0.093, 1.25),
    ("SCS3_high_vol", 20, 3.0, 0.05, 0.093, 1.25),
    ("SCS4_cheap", 10, 2.0, 0.05, 0.093, 1.25),
    ("SCS5_gain_8pct", 20, 2.0, 0.08, 0.093, 1.25),
    ("SCS6_gain_3pct", 20, 2.0, 0.03, 0.093, 1.25),
    ("SCS7_limitup", 20, 2.0, 0.093, 0.11, 1.25),
    ("SCS8_30yuan", 30, 2.0, 0.05, 0.093, 1.25),
    ("SCS9_no_trend_filter", 20, 2.0, 0.05, 0.093, 999),
    ("SCS10_1.5x_vol", 20, 1.5, 0.05, 0.093, 1.25),
]

for vname, price_max, vol_min, gain_min, gain_max, max_ma20_mult in variants:
    rows = conn.execute(f"""
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
          COUNT(*) as n,
          AVG((d3_close - close) / close * 100) as avg_d3,
          MEDIAN((d3_close - close) / close * 100) as med_d3,
          COUNT(*) FILTER (WHERE (d3_close - close) / close > 0) * 100.0 / COUNT(*) as wr,
          MAX((d3_close - close) / close * 100) as max_d3,
          MIN((d3_close - close) / close * 100) as min_d3
        FROM daily
        WHERE prev_close > 0 AND close <= {price_max}
          AND (close - prev_close) / prev_close >= {gain_min} AND (close - prev_close) / prev_close < {gain_max}
          AND volume / vol_ma20 >= {vol_min}
          AND d3_close IS NOT NULL
          AND (close / ma20 < {max_ma20_mult} OR {max_ma20_mult} >= 100)
    """).fetchall()
    
    r = rows[0]
    print(f"{vname:18s} N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Max={r[4]:+.2f}% Min={r[5]:+.2f}%")

conn.close()
