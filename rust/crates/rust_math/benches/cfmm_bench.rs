use criterion::{black_box, criterion_group, criterion_main, Criterion};
use rust_math::{
    cfmm_amount_out, cfmm_arb_profit, cfmm_optimal_input, cfmm_price_impact,
    isqrt, sqrt_price_x96_to_price, v3_approximate_amount_out, Q96,
};

// ─── isqrt ────────────────────────────────────────────────────────────────────

fn bench_isqrt(c: &mut Criterion) {
    c.bench_function("isqrt/u64", |b| b.iter(|| isqrt(black_box(u64::MAX as u128))));
    c.bench_function("isqrt/u128_large", |b| {
        b.iter(|| isqrt(black_box(u128::MAX / 4)))
    });
}

// ─── CFMM amount out ─────────────────────────────────────────────────────────

fn bench_cfmm_amount_out(c: &mut Criterion) {
    // Typical Arbitrum pool: WETH/USDC, 10k WETH / 8k USDC
    let reserve_in: u128 = 10_000 * 10u128.pow(18); // 10k WETH (18 dec)
    let reserve_out: u128 = 8_000 * 10u128.pow(6);  //  8k USDC  ( 6 dec)
    let amount_in: u128 = 10u128.pow(18);             //  1 WETH

    c.bench_function("cfmm_amount_out/typical", |b| {
        b.iter(|| {
            cfmm_amount_out(
                black_box(reserve_in),
                black_box(reserve_out),
                black_box(amount_in),
                black_box(30),
            )
        })
    });
}

// ─── CFMM price impact ───────────────────────────────────────────────────────

fn bench_cfmm_price_impact(c: &mut Criterion) {
    let reserve_in: u128 = 10_000 * 10u128.pow(18);
    let amount_in: u128 = 100 * 10u128.pow(18); // 100 WMATIC

    c.bench_function("cfmm_price_impact/100_wmatic", |b| {
        b.iter(|| cfmm_price_impact(black_box(reserve_in), black_box(amount_in), black_box(30)))
    });
}

// ─── CFMM optimal input ──────────────────────────────────────────────────────

fn bench_cfmm_optimal_input(c: &mut Criterion) {
    // Pool 1 (higher price): 8k WMATIC / 7k USDC
    let r1: u128 = 8_000 * 10u128.pow(18);
    let s1: u128 = 7_000 * 10u128.pow(6);
    // Pool 2 (lower price): 10k WMATIC / 8k USDC
    let r2: u128 = 10_000 * 10u128.pow(18);
    let s2: u128 = 8_000 * 10u128.pow(6);

    c.bench_function("cfmm_optimal_input/two_pool", |b| {
        b.iter(|| {
            cfmm_optimal_input(
                black_box(r1), black_box(s1), black_box(30),
                black_box(r2), black_box(s2), black_box(30),
            )
        })
    });
}

// ─── CFMM arb profit ─────────────────────────────────────────────────────────

fn bench_cfmm_arb_profit(c: &mut Criterion) {
    let r1: u128 = 8_000 * 10u128.pow(18);
    let s1: u128 = 7_000 * 10u128.pow(6);
    let r2: u128 = 10_000 * 10u128.pow(18);
    let s2: u128 = 8_000 * 10u128.pow(6);
    let x = cfmm_optimal_input(r1, s1, 30, r2, s2, 30);

    c.bench_function("cfmm_arb_profit/at_optimal", |b| {
        b.iter(|| {
            cfmm_arb_profit(
                black_box(x),
                black_box(r1), black_box(s1), black_box(30),
                black_box(r2), black_box(s2), black_box(30),
            )
        })
    });
}

// ─── V3 sqrt price conversion ─────────────────────────────────────────────────

fn bench_sqrt_price(c: &mut Criterion) {
    // sqrtPriceX96 ≈ $0.80 USDC per WMATIC
    let sqrt_price: u128 = 56_022_770_974_786_143_748_341_760;

    c.bench_function("sqrt_price_x96_to_price", |b| {
        b.iter(|| {
            sqrt_price_x96_to_price(black_box(sqrt_price), black_box(18), black_box(6), black_box(true))
        })
    });

    c.bench_function("v3_approximate_amount_out", |b| {
        b.iter(|| {
            v3_approximate_amount_out(
                black_box(10u128.pow(18)), // 1 WMATIC
                black_box(sqrt_price),
                black_box(3000),
                black_box(18),
                black_box(6),
                black_box(true),
            )
        })
    });
}

// ─── Full two-pool pipeline ────────────────────────────────────────────────────

fn bench_full_pipeline(c: &mut Criterion) {
    // Simulate a full scan: 20 pools × compute optimal input + profit
    let pools: Vec<(u128, u128, u32)> = (0..20)
        .map(|i| {
            let r = 8_000u128 * 10u128.pow(18) + i * 100 * 10u128.pow(18);
            let s = 7_000u128 * 10u128.pow(6) + i * 50 * 10u128.pow(6);
            (r, s, 30)
        })
        .collect();

    c.bench_function("full_pipeline/20_pools", |b| {
        b.iter(|| {
            let mut best_profit = 0u128;
            for i in 0..pools.len() {
                for j in 0..pools.len() {
                    if i == j {
                        continue;
                    }
                    let (r1, s1, f1) = pools[i];
                    let (r2, s2, f2) = pools[j];
                    let x = cfmm_optimal_input(
                        black_box(r1), black_box(s1), black_box(f1),
                        black_box(r2), black_box(s2), black_box(f2),
                    );
                    if x > 0 {
                        let p = cfmm_arb_profit(
                            black_box(x),
                            black_box(r1), black_box(s1), black_box(f1),
                            black_box(r2), black_box(s2), black_box(f2),
                        );
                        if p > best_profit {
                            best_profit = p;
                        }
                    }
                }
            }
            best_profit
        })
    });
}

criterion_group!(
    benches,
    bench_isqrt,
    bench_cfmm_amount_out,
    bench_cfmm_price_impact,
    bench_cfmm_optimal_input,
    bench_cfmm_arb_profit,
    bench_sqrt_price,
    bench_full_pipeline,
);
criterion_main!(benches);
