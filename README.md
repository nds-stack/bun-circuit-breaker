# @nds-stack/bun-circuit-breaker

> Zero-dependency circuit breaker for Bun — fail-fast resilience with closed/open/half-open state machine.

[![npm version](https://img.shields.io/npm/v/%40nds-stack%2Fbun-circuit-breaker?color=blue&logo=npm)](https://www.npmjs.com/package/@nds-stack/bun-circuit-breaker) [![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.0-black?logo=bun)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## How It Works

Circuit Breaker wraps calls to external services and tracks failures. When failures exceed a threshold, the circuit **opens** and subsequent calls are rejected immediately (fail-fast) without hitting the downstream service. After a configurable timeout, the circuit transitions to **half-open** to probe whether the service has recovered. If the probe succeeds (configurable number of successes), the circuit closes again and normal operation resumes.

```
CLOSED ── failures ≥ threshold ──→ OPEN
  ↑                                    │
  │              ←── success ──── HALF-OPEN ←── resetTimeout expires
```

This prevents cascading failures, reduces resource waste on unhealthy services, and enables automatic recovery.

---

## Installation

```bash
bun add @nds-stack/bun-circuit-breaker
```

---

## API

### Constructor

```typescript
new CircuitBreaker(options?: CircuitBreakerOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `threshold` | `number` | `5` | Number of consecutive failures before opening the circuit |
| `resetTimeout` | `number` | `30000` | Milliseconds to wait before transitioning to half-open |
| `successThreshold` | `number` | `1` | Number of consecutive successes in half-open to close the circuit |
| `failureRateThreshold` | `number` | `0` (disabled) | Failure rate (0–1) within rolling window to open circuit. Set to a value between 0 and 1 to enable time-based failure counting alongside the existing consecutive threshold. |
| `rollingWindow` | `number` | `10000` | Time window in milliseconds for failure rate calculation. Only used when `failureRateThreshold` is set. |
| `minimumCalls` | `number` | `10` | Minimum calls required within the rolling window before rate-based circuit opening activates. Only used when `failureRateThreshold` is set. |
| `maxPending` | `number` | `1000` | Maximum pending calls in the promise-chain mutex queue. Exceeding this immediately throws `CircuitBreakerOpenError` to prevent unbounded memory growth. |
| `onOpen` | `() => void` | — | Callback when circuit opens |
| `onHalfOpen` | `() => void` | — | Callback when circuit becomes half-open |
| `onClose` | `() => void` | — | Callback when circuit closes |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `call(fn)` | `Promise<T>` | Execute a function through the circuit breaker |
| `forceOpen()` | `void` | Manually force the circuit to open state |
| `forceClose()` | `void` | Manually force the circuit to closed state |
| `reset()` | `void` | Reset all stats and return to closed state |
| `stats()` | `CircuitStats` | Get current circuit statistics |
| `on(event, handler)` | `void` | Subscribe to state transition events |
| `off(event, handler)` | `void` | Unsubscribe from state transition events |
| `removeAllListeners(event?)` | `void` | Remove all listeners for an event, or all events if no event specified |

### Properties

| Property | Returns | Description |
|----------|---------|-------------|
| `state` | `CircuitState` | Current state: `'closed' \| 'open' \| 'half-open'` |
| `isOpen` | `boolean` | Whether circuit is open |
| `isHalfOpen` | `boolean` | Whether circuit is half-open |
| `isClosed` | `boolean` | Whether circuit is closed |

### CircuitStats

| Field | Type | Description |
|-------|------|-------------|
| `state` | `CircuitState` | Current state |
| `successCount` | `number` | Total successful calls |
| `failureCount` | `number` | Total failed calls |
| `totalCalls` | `number` | Total calls made |
| `openCount` | `number` | How many times the circuit opened |
| `lastFailure` | `{ error, timestamp } \| undefined` | Details of last failure |
| `lastSuccess` | `{ timestamp } \| undefined` | Timestamp of last success |
| `uptime` | `number` | Milliseconds since creation or last reset |
| `rollingFailureRate` | `number \| undefined` | Current failure rate within the rolling window (only present when `failureRateThreshold` is set) |
| `rollingCallsInWindow` | `number \| undefined` | Total calls within the current rolling window (only present when `failureRateThreshold` is set) |
| `failureRateThreshold` | `number \| undefined` | Configured failure rate threshold (only present when set) |

---

## Error Handling

The circuit breaker communicates errors through exceptions:

### CircuitBreakerOpenError
Thrown when `call()` is invoked while the circuit is **open** and the `resetTimeout` has not elapsed. This is the fail-fast mechanism — no downstream call is attempted.

```typescript
import { CircuitBreaker, CircuitBreakerOpenError } from "@nds-stack/bun-circuit-breaker";

const cb = new CircuitBreaker({ threshold: 1 });

try {
  await cb.call(() => Promise.reject(new Error("service down")));
} catch { }

try {
  await cb.call(() => Promise.resolve("ok"));
} catch (err) {
  if (err instanceof CircuitBreakerOpenError) {
    console.log("Fail-fast:", err.message);
    // err.code === "CIRCUIT_BREAKER_OPEN"
  }
}
```

### Propagated Errors
When the circuit is **closed** or **half-open** and the wrapped function throws, the error propagates to the caller. The circuit breaker tracks the failure but does not swallow or modify the error.

### Queue Full
When the number of pending calls exceeds `maxPending` (default 1000), `call()` immediately throws `CircuitBreakerOpenError` without queueing. The error `code` is `CIRCUIT_BREAKER_OPEN` (same as circuit-open). Differentiate via `err.message` if needed:

```typescript
import { CircuitBreaker, CircuitBreakerOpenError } from "@nds-stack/bun-circuit-breaker";

const cb = new CircuitBreaker({ maxPending: 5 });

try {
  await cb.call(() => Promise.resolve("ok"));
} catch (err) {
  if (err instanceof CircuitBreakerOpenError) {
    if ((err as Error).message.includes("queue full")) {
      // Circuit breaker queue is full — retry with backoff
    } else {
      // Circuit is open — fail-fast
    }
  }
}
```

### Validation Errors
Constructor throws `RangeError` for invalid option values:
- `threshold` must be >= 0
- `resetTimeout` must be >= 0
- `successThreshold` must be >= 1
- `failureRateThreshold` must be between 0 and 1 (exclusive, when set)
- `rollingWindow` must be >= 100ms
- `minimumCalls` must be >= 1
- `maxPending` must be >= 1

### Silent Handling
- Event handler errors are silently caught to prevent handler exceptions from breaking state transitions
- Callback options (`onOpen`, `onHalfOpen`, `onClose`) that throw are caught and ignored

---

## Limitations

| Limitation | Description |
|------------|-------------|
| **In-process only** | Circuit state is local to the current process. Multi-instance deployments need a shared state store. |
| **Consecutive counting** | Consecutive failure counting resets on success in closed state. Enable `failureRateThreshold` for time-window based counting. |
| **No async hooks** | The mutex pattern ensures sequential state transitions but does not use async hooks / async context tracking. |
| **Stale stats reads** | `stats()` reads counters outside the mutex for performance. During an active `call()`, `totalCalls` may already be incremented while `successCount` / `failureCount` are not yet updated. |
| **Hanging `fn()` blocks mutex** | The promise-chain mutex serializes all calls. If the wrapped function never settles (no timeout, infinite loop, unresponsive service), the entire queue stalls permanently. Always wrap external calls with a timeout (`AbortController`, `Promise.race` with `Bun.sleep`). |
| **No network awareness** | Circuit breaker is logic-only. It doesn't detect network partitions; it counts failures from the wrapped function. |
| **No built-in retry** | Combine with `bun-retry` for retry-with-circuit-breaker pattern. |

---

## Rolling Window (Time-Based Failure Counting)

In addition to consecutive failure counting (`threshold`), you can enable rolling window failure rate detection. This is useful for services that have intermittent failures — where the failure rate stays high enough to warrant opening the circuit, even though consecutive failures keep getting reset by occasional successes.

### How It Works

When `failureRateThreshold` is set, every call (success or failure) is recorded in time buckets within a sliding `rollingWindow`. After each failure in `closed` state, the circuit breaker checks if the failure rate within the window exceeds the threshold **and** the minimum number of calls has been met.

```
closed state:
  consecutive failures ≥ threshold   → open (immediate, existing)
  OR
  calls in window ≥ minimumCalls AND
  failure rate within window ≥ failureRateThreshold → open (time-based)
```

### Configuration

```typescript
import { CircuitBreaker } from "@nds-stack/bun-circuit-breaker";

const cb = new CircuitBreaker({
  // Consecutive failure tracking (still active)
  threshold: 10,

  // Rolling window (optional, time-based)
  failureRateThreshold: 0.5,      // Open if 50%+ of requests fail within the window
  rollingWindow: 10000,           // 10-second rolling window
  minimumCalls: 20,               // Require at least 20 calls before evaluating
});
```

### When to Use Rolling Window

| Scenario | Consecutive (threshold) | Rolling Window |
|----------|------------------------|----------------|
| Service completely down | ✅ Opens fast | ✅ Opens within window |
| Service intermittently failing (50% failure rate) | ❌ Might stay closed | ✅ Opens after minimumCalls |
| Single call spike of failures | ✅ Opens fast | ✅ Opens but may be delayed |
| Low-traffic endpoint (< minimumCalls per window) | ✅ Preferred | ❌ May never meet minimumCalls |

### Stats Reflection

When `failureRateThreshold` is configured, `stats()` includes:

```typescript
const s = cb.stats();
console.log(s.rollingFailureRate);    // e.g., 0.33 (33% failure rate)
console.log(s.rollingCallsInWindow);  // e.g., 15 calls in the last 10s
console.log(s.failureRateThreshold);  // 0.5
```

---

## Multi-Instance / Cross-Boundary

`CircuitBreaker` state is per-instance — each Bun process has its own state machine. For multi-instance deployments, you have several options:

### Option 1: Per-Instance Circuit Breaker (Simple)

Each process maintains its own circuit breaker. This is fine when:
- Traffic is evenly distributed (each instance sees ~1/N of failures)
- You want independent failure detection per instance

```typescript
// Each instance has its own breaker
const cb = new CircuitBreaker({ threshold: 5 });
```

### Option 2: Shared State via Redis

Use Redis to coordinate circuit state across instances:

```typescript
import { CircuitBreaker } from "@nds-stack/bun-circuit-breaker";

class SharedCircuitBreaker {
  private cb = new CircuitBreaker({ threshold: 3 });

  async call<T>(fn: () => Promise<T>): Promise<T> {
    // Check Redis for global circuit state
    const globalOpen = await redis.get("circuit:users-api");
    if (globalOpen === "open") {
      this.cb.forceOpen();
    }
    return this.cb.call(fn);
  }
}
```

### Option 3: Read-Through Pattern

Use a local circuit breaker per endpoint with a shared failure counter in Redis:

```typescript
async function recordAndCheck(key: string): Promise<boolean> {
  const count = await redis.incr(`failures:${key}`);
  await redis.expire(`failures:${key}`, 60);
  return count >= 5;
}
```

---

## Customization Guide

### Wrap with Retry Logic

```typescript
import { CircuitBreaker } from "@nds-stack/bun-circuit-breaker";

async function callWithRetry<T>(
  cb: CircuitBreaker,
  fn: () => Promise<T>,
  retries = 3
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await cb.call(fn);
    } catch (err) {
      lastError = err;
      if (i < retries) await Bun.sleep(100 * Math.pow(2, i));
    }
  }
  throw lastError;
}
```

### Logging All State Transitions

```typescript
import { CircuitBreaker } from "@nds-stack/bun-circuit-breaker";
import { logger } from "./logger";

const cb = new CircuitBreaker({
  threshold: 5,
  resetTimeout: 30000,
});

cb.on("open", () => logger.warn("Circuit opened"));
cb.on("half-open", () => logger.info("Circuit half-open, probing"));
cb.on("close", () => logger.info("Circuit closed, normal operation"));
```

### Metrics Export

```typescript
import { CircuitBreaker } from "@nds-stack/bun-circuit-breaker";

class MonitoredCircuitBreaker {
  private cb = new CircuitBreaker();

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.cb.call(fn);
      metrics.record("circuit.call_duration", performance.now() - start);
      return result;
    } catch (err) {
      metrics.increment("circuit.failures");
      throw err;
    }
  }

  get stats() {
    return this.cb.stats();
  }
}
```

### Type-Safe Wrapper

```typescript
import { CircuitBreaker } from "@nds-stack/bun-circuit-breaker";

class ServiceClient {
  private cb = new CircuitBreaker({ threshold: 3, resetTimeout: 10000 });

  async fetchUser(id: string): Promise<User> {
    return this.cb.call(() => fetch(`/api/users/${id}`).then(r => r.json()));
  }

  async fetchPosts(userId: string): Promise<Post[]> {
    return this.cb.call(() => fetch(`/api/users/${userId}/posts`).then(r => r.json()));
  }
}
```

---

## Comparison Table

| Feature | Manual try/catch | `opossum` (npm) | `cockatiel` (npm) | bun-circuit-breaker |
|---------|-----------------|-----------------|-------------------|---------------------|
| Bun-native | ✅ | ❌ Node.js polyfills | ❌ Node.js polyfills | ✅ |
| Zero dependencies | ✅ | ❌ | ❌ | ✅ |
| State machine | ❌ Manual | ✅ | ✅ | ✅ |
| Event emitter | ❌ | ✅ | ✅ | ✅ |
| Callbacks (onOpen/onClose) | ❌ | ✅ | ✅ | ✅ |
| `performance.now()` timing | ❌ Date | ❌ Date | ❌ Date | ✅ |
| Promise-chain mutex | ❌ | ❌ | ❌ | ✅ |
| Rolling window (time-based) | ❌ | ✅ (errorThresholdPercentage) | ✅ (SamplingBreaker) | ✅ (failureRateThreshold) |
| Bundle size | 0KB | ~391KB | ~262KB | **~1.5KB** |
| TypeScript strict | — | Partial | Partial | ✅ |

---

## Benchmarks

### Methodology
- Each operation: average of **5 rounds × 5000 iterations × 3 samples**
- Warmup: 2000 iterations before measurement
- Hardware: Bun 1.3.14 (Windows, x64)

### Results (ops/s — higher is better)

| Operation | `@nds-stack/bun-circuit-breaker` | `opossum` | `cockatiel` | Overhead vs opossum |
|-----------|:---:|:---:|:---:|:---:|
| Baseline (no CB) | **1,850,947** 🏆 | — | — | — |
| Persistent (success) | 718,084 | 457,842 | **846,650** 🏆 | **+57%** |
| Per-instance (success) | **535,030** 🏆 | — | — | — |
| Open rejection | 196,021 | **352,320** 🏆 | — | -44% |

> **Note:** cockatiel is faster in the success path because it uses a simpler internal architecture without a promise-chain mutex. The trade-off is that `@nds-stack/bun-circuit-breaker` guarantees **thread-safe state transitions** under concurrent calls via its promise-chain mutex — essential for correctness in real-world concurrent workloads.
>
> Against opossum, `@nds-stack/bun-circuit-breaker` is still **57% faster** while being **zero-dependency**, **Bun-native**, and **~260× smaller**.

To reproduce: `bun install && bun run bench`

Performance tip: Reuse a single `CircuitBreaker` instance per endpoint/service for best throughput (avoid per-call construction overhead).

---

## Real-World Example

```typescript
import { CircuitBreaker, CircuitBreakerOpenError } from "@nds-stack/bun-circuit-breaker";

interface APIClientOptions {
  baseURL: string;
  timeout?: number;
  circuitBreaker?: {
    threshold?: number;
    resetTimeout?: number;
    successThreshold?: number;
  };
}

class ResilientAPIClient {
  private cb: CircuitBreaker;

  constructor(private opts: APIClientOptions) {
    this.cb = new CircuitBreaker({
      threshold: opts.circuitBreaker?.threshold ?? 3,
      resetTimeout: opts.circuitBreaker?.resetTimeout ?? 15000,
      successThreshold: opts.circuitBreaker?.successThreshold ?? 2,
      onOpen: () => console.error(`[${opts.baseURL}] Circuit OPEN — fail-fast`),
      onClose: () => console.log(`[${opts.baseURL}] Circuit CLOSED — recovered`),
    });
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.opts.baseURL}${path}`;

    return this.cb.call(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.opts.timeout ?? 5000
      );

      try {
        const res = await fetch(url, {
          ...init,
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        return res.json() as Promise<T>;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  get stats() {
    return this.cb.stats();
  }
}

// Usage
const api = new ResilientAPIClient({
  baseURL: "https://api.example.com",
  timeout: 3000,
  circuitBreaker: { threshold: 3, resetTimeout: 10000 },
});

async function main() {
  try {
    const users = await api.get<User[]>("/users");
    console.log(`Fetched ${users.length} users`);
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      console.log("API is down, using cached data");
    } else {
      console.error("Request failed:", err);
    }
  }

  console.log("Circuit stats:", api.stats);
}
```

---

## License

MIT
