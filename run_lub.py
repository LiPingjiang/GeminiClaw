import duckdb
conn = duckdb.connect("/opt/dragon-stock/data/stock_monitor_readonly.duckdb", read_only=True)

print("="*70)
print("LIMIT-UP BREAK — Fast DuckDB Batch Query")
print("="*70)

variants = [
    ("LUB1_base", 0.00, 0.05, 0.00, 0.093, 1.0),
    ("LUB2_open_2pct", 0.02, 0.05, 0.00, 0.093, 1.0),
    ("LUB3_open_3pct", 0.03, 0.06, 0.00, 0.093, 1.0),
    ("LUB4_high_vol", 0.00, 0.05, 0.00, 0.093, 1.5),
    ("LUB5_open_high_vol", 0.02, 0.05, 0.00, 0.093, 1.5),
    ("LUB6_close_up_2pct", 0.00, 0.05, 0.02, 0.093, 1.0),
    ("LUB7_close_up_5pct", 0.00, 0.05, 0.05, 0.093, 1.0),
    ("LUB8_low_vol", 0.00, 0.05, 0.00, 0.093, 0.8),
    ("LUB9_open_5pct", 0.05, 0.10, 0.00, 0.093, 1.0),
    ("LUB10_vol_2x", 0.00, 0.05, 0.00, 0.093, 2.0),
]

for vname, open_min, open_max, close_min, close_max, vol_min in variants:
    rows = conn.execute(f"""
        WITH daily AS (
          SELECT code, date, close, open, volume,
                 LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
                 LAG(volume, 1) OVER (PARTITION BY code ORDER BY date) as prev_vol
          FROM daily_kline
          WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
        ),
        signals AS (
          SELECT *,
            (prev_close - LAG(close, 2) OVER (PARTITION BY code ORDER BY date)) / LAG(close, 2) OVER (PARTITION BY code ORDER BY date) as yest_gain,
            (close - prev_close) / prev_close as today_gain,
            (open - prev_close) / prev_close as open_gain,
            volume / prev_vol as vol_ratio,
            LEAD(close, 2) OVER (PARTITION BY code ORDER BY date) as d2_close
          FROM daily
          WHERE prev_close > 0 AND prev_vol > 0
        )
        SELECT 
          COUNT(*) as n,
          AVG((d2_close - close) / close * 100) as avg_d2,
          MEDIAN((d2_close - close) / close * 100) as med_d2,
          COUNT(*) FILTER (WHERE (d2_close - close) / close > 0) * 100.0 / COUNT(*) as wr,
          MAX((d2_close - close) / close * 100) as max_d2,
          MIN((d2_close - close) / close * 100) as min_d2
        FROM signals
        WHERE yest_gain >= 0.093
          AND today_gain >= {close_min} AND today_gain < {close_max}
          AND open_gain >= {open_min} AND open_gain <= {open_max}
          AND vol_ratio >= {vol_min}
          AND d2_close IS NOT NULL
    """).fetchall()
    
    r = rows[0]
    print(f"{vname:18s} N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}% Max={r[4]:+.2f}% Min={r[5]:+.2f}%")

conn.close()
