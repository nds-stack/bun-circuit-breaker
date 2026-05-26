import { CircuitBreaker as NdsCircuitBreaker } from "../src/index.ts";
import Opossum from "opossum";
import { circuitBreaker, handleAll, ConsecutiveBreaker } from "cockatiel";

const iterations = 5_000;
const samples = 3;
const rounds = 5;

type ScenarioFn = () => Promise<void>;

function bench(fn: ScenarioFn): Promise<number> {
  return (async () => {
    const start = performance.now();
    for (let s = 0; s < samples; s++) {
      for (let i = 0; i < iterations; i++) {
        await fn();
      }
    }
    const elapsed = performance.now() - start;
    const totalOps = iterations * samples;
    return Math.round(totalOps / (elapsed / 1000));
  })();
}

async function runMultiple(scenario: () => ScenarioFn): Promise<number> {
  const results: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const fn = scenario();
    results.push(await bench(fn));
  }
  const sum = results.reduce((a, b) => a + b, 0);
  return Math.round(sum / results.length);
}

interface BenchResult {
  name: string;
  ops: number;
}

(async () => {
  const results: BenchResult[] = [];

  // --- Warmup ---
  const warmupCb = new NdsCircuitBreaker({ threshold: 10000 });
  for (let i = 0; i < 2000; i++) { await warmupCb.call(async () => "ok"); }

  // --- Raw baseline (no circuit breaker) ---
  results.push({
    name: "raw async fn (baseline)",
    ops: await runMultiple(() => async () => {
      await (async () => "ok")();
    }),
  });

  // --- @nds-stack/bun-circuit-breaker (per-instance) ---
  results.push({
    name: "@nds-stack/bun-circuit-breaker (per-instance)",
    ops: await runMultiple(() => async () => {
      const c = new NdsCircuitBreaker({ threshold: 1000 });
      await c.call(async () => "ok");
    }),
  });

  // --- @nds-stack/bun-circuit-breaker (persistent) ---
  const cbPersistent = new NdsCircuitBreaker({ threshold: 10000 });
  results.push({
    name: "@nds-stack/bun-circuit-breaker (persistent)",
    ops: await runMultiple(() => async () => {
      await cbPersistent.call(async () => "ok");
    }),
  });

  // --- opossum (persistent) ---
  const opossumBreaker = new Opossum(async () => "ok", {
    timeout: 10000,
    errorThresholdPercentage: 99,
    resetTimeout: 60000,
    volumeThreshold: 10000,
  });
  results.push({
    name: "opossum (persistent)",
    ops: await runMultiple(() => async () => {
      await opossumBreaker.fire();
    }),
  });

  // --- cockatiel (persistent) ---
  const cockatielBreaker = circuitBreaker(handleAll, {
    halfOpenAfter: 60000,
    breaker: new ConsecutiveBreaker(10000),
  });
  results.push({
    name: "cockatiel (persistent)",
    ops: await runMultiple(() => async () => {
      await cockatielBreaker.execute(() => Promise.resolve("ok"));
    }),
  });

  // --- @nds-stack/bun-circuit-breaker (open circuit rejection) ---
  const cbOpen = new NdsCircuitBreaker({ threshold: 1, resetTimeout: 60000 });
  try { await cbOpen.call(async () => { throw new Error("fail"); }); } catch { }
  results.push({
    name: "@nds-stack/bun-circuit-breaker (open rejection)",
    ops: await runMultiple(() => async () => {
      try { await cbOpen.call(async () => "ok"); } catch { }
    }),
  });

  // --- opossum (open circuit rejection) ---
  const opossumOpen = new Opossum(async () => { throw new Error("fail"); }, {
    errorThresholdPercentage: 1,
    resetTimeout: 60000,
    volumeThreshold: 1,
  });
  await opossumOpen.fire().catch(() => {});
  await Bun.sleep(100);
  results.push({
    name: "opossum (open rejection)",
    ops: await runMultiple(() => async () => {
      try { await opossumOpen.fire(); } catch { }
    }),
  });

  // --- Display ---
  console.log("\n--- Circuit Breaker Benchmark: @nds-stack vs Competitors ---");
  console.log(`Bun ${Bun.version}, ${iterations} iterations × ${samples} samples × ${rounds} rounds (avg)\n`);

  const opPad = results.reduce((m, r) => Math.max(m, r.name.length), 0);
  const pad = (s: string, n: number) => s.padEnd(n);
  const base = 2;

  const opossumPersistent = results.find(r => r.name === "opossum (persistent)")?.ops ?? 1;
  const cockatielPersistent = results.find(r => r.name === "cockatiel (persistent)")?.ops ?? 1;

  const headerOp = pad("Operation", opPad + base);
  const headerOps = pad("ops/s", 14);
  const headerVsO = pad("vs opossum", 12);
  const headerVsC = pad("vs cockatiel", 14);
  console.log(`${headerOp} | ${headerOps} | ${headerVsO} | ${headerVsC}`);
  console.log(`${"-".repeat(opPad + base)}-|-${"-".repeat(14)}-|-${"-".repeat(12)}-|-${"-".repeat(14)}`);

  for (const r of results) {
    const vsO = r.name.includes("opossum") ? "—" :
      r.ops >= opossumPersistent
        ? `+${((r.ops / opossumPersistent - 1) * 100).toFixed(0)}%`
        : `${((r.ops / opossumPersistent - 1) * 100).toFixed(0)}%`;
    const vsC = r.name.includes("cockatiel") ? "—" :
      r.name.includes("opossum") ? "—" :
      r.ops >= cockatielPersistent
        ? `+${((r.ops / cockatielPersistent - 1) * 100).toFixed(0)}%`
        : `${((r.ops / cockatielPersistent - 1) * 100).toFixed(0)}%`;
    console.log(`${pad(r.name, opPad + base)} | ${pad(r.ops.toLocaleString("en-US"), 14)} | ${pad(vsO, 12)} | ${pad(vsC, 14)}`);
  }

  console.log("");
})();
