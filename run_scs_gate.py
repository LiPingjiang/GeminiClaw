import duckdb
conn = duckdb.connect("/opt/dragon-stock/data/stock_monitor_readonly.duckdb", read_only=True)

print("="*70)
print("SCS7 TIGHT MA20 — Market Regime + Gate Design")
print("="*70)

# --- Market Regime Analysis ---
print("\n--- Annual Performance (SCS7 + tight MA20 < 1.10) ---")
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
      COUNT(*) FILTER (WHERE (d3_close - close) / close > 0) * 100.0 / COUNT(*) as wr,
      STDDEV_SAMP((d3_close - close) / close * 100) as std
    FROM daily
    WHERE prev_close > 0 AND close <= 20
      AND (close - prev_close) / prev_close >= 0.093 AND (close - prev_close) / prev_close < 0.11
      AND volume / vol_ma20 >= 2.0
      AND close / ma20 < 1.10
      AND d3_close IS NOT NULL
    GROUP BY year
    ORDER BY year
""").fetchall()

for r in rows:
    print(f"  {r[0]} N={r[1]:5d} Avg={r[2]:+.2f}% Med={r[3]:+.2f}% WR={r[4]:.1f}% Std={r[5]:.2f}%")

# --- Monthly Signal Count ---
print("\n--- Monthly Signal Count (for Gate Design) ---")
rows = conn.execute("""
    WITH daily AS (
      SELECT code, date, close, open, volume,
             LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
             AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
             AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20
      FROM daily_kline
      WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
    )
    SELECT 
      SUBSTR(date, 1, 7) as month,
      COUNT(*) as n
    FROM daily
    WHERE prev_close > 0 AND close <= 20
      AND (close - prev_close) / prev_close >= 0.093 AND (close - prev_close) / prev_close < 0.11
      AND volume / vol_ma20 >= 2.0
      AND close / ma20 < 1.10
    GROUP BY month
    ORDER BY month
""").fetchall()

monthly_counts = [r[1] for r in rows]
if monthly_counts:
    print(f"  Monthly signal count: min={min(monthly_counts)} max={max(monthly_counts)} avg={sum(monthly_counts)/len(monthly_counts):.0f}")
    # Show top 10 highest and lowest months
    sorted_months = sorted(rows, key=lambda x: x[1])
    print(f"  Lowest: {sorted_months[0][0]} = {sorted_months[0][1]} signals")
    print(f"  Highest: {sorted_months[-1][0]} = {sorted_months[-1][1]} signals")

# --- Gate Design Test ---
print("\n--- Gate Design (Signal Count Thresholds) ---")
# Simulate different gate thresholds
for threshold in [10, 25, 50, 100, 200, 500, 1000]:
    rows = conn.execute(f"""
        WITH daily AS (
          SELECT code, date, close, open, volume,
                 LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
                 AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
                 AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
                 LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) as d3_close,
                 COUNT(*) OVER (PARTITION BY date) as daily_count
          FROM daily_kline
          WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
        )
        SELECT 
          COUNT(*) as n,
          AVG((d3_close - close) / close * 100) as avg,
          MEDIAN((d3_close - close) / close * 100) as med,
          COUNT(*) FILTER (WHERE (d3_close - close) / close > 0) * 100.0 / COUNT(*) as wr
        FROM daily
        WHERE prev_close > 0 AND close <= 20
          AND (close - prev_close) / prev_close >= 0.093 AND (close - prev_close) / prev_close < 0.11
          AND volume / vol_ma20 >= 2.0
          AND close / ma20 < 1.10
          AND d3_close IS NOT NULL
          AND daily_count >= {threshold}
    """).fetchall()
    
    r = rows[0]
    if r[0] and r[0] > 0:
        print(f"  Gate >= {threshold:4d} signals/day: N={r[0]:5d} Avg={r[1]:+.2f}% Med={r[2]:+.2f}% WR={r[3]:.1f}%")
    else:
        print(f"  Gate >= {threshold:4d} signals/day: No signals")

# --- Stop Loss Test (D1) ---
print("\n--- Stop Loss Analysis (D1 Exit) ---")
rows = conn.execute("""
    WITH daily AS (
      SELECT code, date, close, open, volume,
             LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
             AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
             AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
             LEAD(close, 1) OVER (PARTITION BY code ORDER BY date) as d1_close
      FROM daily_kline
      WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
    )
    SELECT 
      AVG((d1_close - close) / close * 100) as avg_d1,
      MEDIAN((d1_close - close) / close * 100) as med_d1,
      COUNT(*) FILTER (WHERE (d1_close - close) / close > 0) * 100.0 / COUNT(*) as wr_d1,
      COUNT(*) FILTER (WHERE (d1_close - close) / close < -0.05) * 100.0 / COUNT(*) as pct_loss_5pct,
      COUNT(*) FILTER (WHERE (d1_close - close) / close < -0.03) * 100.0 / COUNT(*) as pct_loss_3pct,
      COUNT(*) FILTER (WHERE (d1_close - close) / close > 0.05) * 100.0 / COUNT(*) as pct_gain_5pct
    FROM daily
    WHERE prev_close > 0 AND close <= 20
      AND (close - prev_close) / prev_close >= 0.093 AND (close - prev_close) / prev_close < 0.11
      AND volume / vol_ma20 >= 2.0
      AND close / ma20 < 1.10
      AND d1_close IS NOT NULL
""").fetchall()

r = rows[0]
print(f"  D1 Avg={r[0]:+.2f}% Med={r[1]:+.2f}% WR={r[2]:.1f}%")
print(f"  D1 loss > 5%: {r[3]:.1f}% of signals | D1 loss > 3%: {r[4]:.1f}%")
print(f"  D1 gain > 5%: {r[5]:.1f}% of signals")

# --- D1 Stop Loss Simulation ---
print("\n--- D1 Stop Loss Simulation ---")
for stop in [-0.03, -0.05, -0.07, -0.10]:
    rows = conn.execute(f"""
        WITH daily AS (
          SELECT code, date, close, open, volume,
                 LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close,
                 AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
                 AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as vol_ma20,
                 LEAD(close, 1) OVER (PARTITION BY code ORDER BY date) as d1_close,
                 LEAD(close, 3) OVER (PARTITION BY code ORDER BY date) as d3_close
          FROM daily_kline
          WHERE market IN ('SH','SZ') AND date >= '2019-01-01' AND close > 0
        )
        SELECT 
          COUNT(*) as n,
          AVG(CASE 
            WHEN (d1_close - close) / close < {stop} THEN {stop} * 100
            ELSE (d3_close - close) / close * 100
          END) as avg_stop,
          COUNT(*) FILTER (WHERE 
            CASE WHEN (d1_close - close) / close < {stop} THEN {stop} ELSE (d3_close - close) / close END > 0
          ) * 100.0 / COUNT(*) as wr_stop
        FROM daily
        WHERE prev_close > 0 AND close <= 20
          AND (close - prev_close) / prev_close >= 0.093 AND (close - prev_close) / prev_close < 0.11
          AND volume / vol_ma20 >= 2.0
          AND close / ma20 < 1.10
          AND d1_close IS NOT NULL AND d3_close IS NOT NULL
    """).fetchall()
    
    r = rows[0]
    print(f"  Stop {stop*100:+.0f}%: N={r[0]:5d} Avg={r[1]:+.2f}% WR={r[2]:.1f}%")

conn.close()
