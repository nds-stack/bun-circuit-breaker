import { CircuitBreaker, CircuitBreakerOpenError } from "../src/index.ts";

async function unreliableApi(succeed: boolean): Promise<string> {
  if (!succeed) throw new Error("Service unavailable");
  return "response data";
}

async function main() {
  const cb = new CircuitBreaker({
    threshold: 3,
    resetTimeout: 5000,
    successThreshold: 2,
    onOpen: () => console.log("⚠ Circuit OPEN — fail-fast mode"),
    onHalfOpen: () => console.log("🔶 Circuit HALF-OPEN — probing..."),
    onClose: () => console.log("✅ Circuit CLOSED — back to normal"),
  });

  for (let i = 0; i < 20; i++) {
    try {
      const result = await cb.call(() => unreliableApi(i > 5));
      console.log(`Call ${i}: ✅ ${result}`);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        console.log(`Call ${i}: 🚫 Circuit open, fast-failing`);
      } else {
        console.log(`Call ${i}: ❌ ${(err as Error).message}`);
      }
    }
    await Bun.sleep(200);
  }

  console.log("\nFinal stats:", cb.stats());
}

main().catch(console.error);
