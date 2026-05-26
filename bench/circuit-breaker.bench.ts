import { CircuitBreaker } from "../src/index.ts";

const iterations = 5_000;
const samples = 3;

function bench(fn: () => Promise<void>): Promise<number> {
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

function format(ops: number): string {
  if (ops > 1_000_000) return `${(ops / 1_000_000).toFixed(1)}M ops/s`;
  if (ops > 1_000) return `${(ops / 1_000).toFixed(0)}K ops/s`;
  return `${ops} ops/s`;
}

(async () => {
  const results: Array<{ name: string; ops: number }> = [];

  results.push({
    name: "CircuitBreaker.call (success)",
    ops: await bench(async () => {
      const c = new CircuitBreaker({ threshold: 1000 });
      await c.call(async () => "ok");
    }),
  });

  const cbPersistent = new CircuitBreaker({ threshold: 10000 });
  results.push({
    name: "CircuitBreaker.call (persistent, success)",
    ops: await bench(async () => {
      const c = cbPersistent;
      await c.call(async () => "ok");
    }),
  });

  console.log("\n--- bun-circuit-breaker Benchmark ---");
  console.log(`Bun ${Bun.version}, ${iterations} iterations × ${samples} samples\n`);

  const opPad = results.reduce((m, r) => Math.max(m, r.name.length), 0);
  const pad = (s: string, n: number) => s.padEnd(n);
  const base = 2;

  console.log(`${pad("Operation", opPad + base)} | ${pad("Throughput", 14)}`);
  console.log(`${"-".repeat(opPad + base)}-|-${"-".repeat(14)}`);

  for (const r of results) {
    console.log(`${pad(r.name, opPad + base)} | ${pad(format(r.ops), 14)}`);
  }

  console.log("");
})();
