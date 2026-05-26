import { test, expect, describe } from "bun:test";
import { CircuitBreaker, CircuitBreakerOpenError } from "../src/index.ts";

async function delay(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

function rejectFn(msg = "fail"): () => Promise<never> {
  return () => Promise.reject(new Error(msg));
}

function resolveFn<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

describe("CircuitBreaker", () => {
  test("initial state is closed", () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.isClosed).toBe(true);
    expect(cb.isOpen).toBe(false);
    expect(cb.isHalfOpen).toBe(false);
  });

  test("calls succeed when closed", async () => {
    const cb = new CircuitBreaker();
    const result = await cb.call(resolveFn("ok"));
    expect(result).toBe("ok");
    const s = cb.stats();
    expect(s.successCount).toBe(1);
    expect(s.failureCount).toBe(0);
  });

  test("opens after threshold failures", async () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    for (let i = 0; i < 3; i++) {
      try { await cb.call(rejectFn()); } catch { }
    }
    expect(cb.state).toBe("open");
    expect(cb.isOpen).toBe(true);
    const s = cb.stats();
    expect(s.failureCount).toBe(3);
    expect(s.openCount).toBe(1);
  });

  test("half-opens after resetTimeout", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 50 });
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
    await delay(60);
    try { await cb.call(resolveFn("after timeout")); } catch { }
    expect(cb.state).toBe("closed");
  });

  test("closes after successThreshold successes in half-open", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 50, successThreshold: 2 });
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
    await delay(60);
    await cb.call(resolveFn("first"));
    expect(cb.state).toBe("half-open");
    await cb.call(resolveFn("second"));
    expect(cb.state).toBe("closed");
  });

  test("CircuitBreakerOpenError thrown when open", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 5000 });
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
    try {
      await cb.call(resolveFn("should not reach"));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
      expect((err as CircuitBreakerOpenError).code).toBe("CIRCUIT_BREAKER_OPEN");
    }
  });

  test("forceOpen() and forceClose()", async () => {
    const cb = new CircuitBreaker();
    await cb.forceOpen();
    expect(cb.state).toBe("open");
    await cb.forceClose();
    expect(cb.state).toBe("closed");
    expect(cb.stats().successCount).toBe(0);
  });

  test("reset() clears stats", async () => {
    const cb = new CircuitBreaker({ threshold: 2 });
    await cb.call(resolveFn("ok"));
    try { await cb.call(rejectFn()); } catch { }
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.stats().totalCalls).toBe(3);
    await cb.reset();
    const s = cb.stats();
    expect(cb.state).toBe("closed");
    expect(s.totalCalls).toBe(0);
    expect(s.failureCount).toBe(0);
    expect(s.openCount).toBe(0);
  });

  test("stats tracking accuracy", async () => {
    const cb = new CircuitBreaker({ threshold: 2, resetTimeout: 5000 });
    await cb.call(resolveFn("a"));
    await cb.call(resolveFn("b"));
    try { await cb.call(rejectFn("err1")); } catch { }
    try { await cb.call(rejectFn("err2")); } catch { }
    const s = cb.stats();
    expect(s.totalCalls).toBe(4);
    expect(s.successCount).toBe(2);
    expect(s.failureCount).toBe(2);
    expect(s.openCount).toBe(1);
    expect(s.state).toBe("open");
    expect(s.lastFailure?.error).toBe("err2");
    expect(s.lastSuccess?.timestamp).toBeGreaterThan(0);
    expect(s.uptime).toBeGreaterThan(0);
  });

  test("onOpen / onHalfOpen / onClose callbacks", async () => {
    const events: string[] = [];
    const cb = new CircuitBreaker({
      threshold: 1,
      resetTimeout: 50,
      onOpen: () => events.push("open"),
      onHalfOpen: () => events.push("half-open"),
      onClose: () => events.push("close"),
    });
    try { await cb.call(rejectFn()); } catch { }
    expect(events).toEqual(["open"]);
    await delay(60);
    await cb.call(resolveFn("ok"));
    expect(events).toEqual(["open", "half-open", "close"]);
  });

  test("event emitter on/off", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 50 });
    const events: string[] = [];
    const handler = () => events.push("open-fired");
    cb.on("open", handler);
    try { await cb.call(rejectFn()); } catch { }
    expect(events).toEqual(["open-fired"]);
    cb.off("open", handler);
    cb.forceClose();
    try { await cb.call(rejectFn()); } catch { }
    expect(events).toEqual(["open-fired"]);
  });

  test("multiple consecutive successes update stats", async () => {
    const cb = new CircuitBreaker();
    await cb.call(resolveFn(1));
    await cb.call(resolveFn(2));
    await cb.call(resolveFn(3));
    const s = cb.stats();
    expect(s.successCount).toBe(3);
    expect(s.failureCount).toBe(0);
    expect(s.totalCalls).toBe(3);
  });

  test("edge case: threshold=0 (opens after first failure)", async () => {
    const cb = new CircuitBreaker({ threshold: 0 });
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
  });

  test("edge case: resetTimeout=0", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 0 });
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
    await cb.call(resolveFn("instant"));
    expect(cb.state).toBe("closed");
  });

  test("circuit survives rapid open/close cycles", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 10 });
    for (let cycle = 0; cycle < 5; cycle++) {
      try { await cb.call(rejectFn(`cycle-${cycle}`)); } catch { }
      expect(cb.state).toBe("open");
      await delay(15);
      await cb.call(resolveFn(`ok-${cycle}`));
      expect(cb.state).toBe("closed");
    }
    const s = cb.stats();
    expect(s.openCount).toBe(5);
    expect(s.totalCalls).toBe(10);
    expect(s.successCount).toBe(5);
    expect(s.failureCount).toBe(5);
  });

  test("failure in half-open reopens circuit", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 50 });
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
    await delay(60);
    try { await cb.call(rejectFn("fail in half-open")); } catch { }
    expect(cb.state).toBe("open");
    const s = cb.stats();
    expect(s.openCount).toBe(2);
  });

  test("concurrent calls are serialized", async () => {
    const cb = new CircuitBreaker({ threshold: 2, resetTimeout: 100 });
    const tasks = [
      cb.call(resolveFn("a")),
      cb.call(resolveFn("b")),
      cb.call(rejectFn("c")),
    ];
    const results = await Promise.allSettled(tasks);
    expect(results.filter(r => r.status === "fulfilled").length).toBeGreaterThanOrEqual(2);
  });

  test("removeAllListeners clears all handlers", async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 50 });
    let count = 0;
    cb.on("open", () => count++);
    cb.on("open", () => count++);
    expect(cb.removeAllListeners).toBeFunction();
    cb.removeAllListeners("open");
    try { await cb.call(rejectFn()); } catch { }
    expect(count).toBe(0);
  });

  test("removeAllListeners without event clears all events", () => {
    const cb = new CircuitBreaker();
    cb.on("open", () => {});
    cb.on("close", () => {});
    cb.on("half-open", () => {});
    cb.removeAllListeners();
    expect(() => {
      cb.on("open", () => {});
    }).not.toThrow();
  });

  test("callbacks that throw are caught and do not corrupt state", async () => {
    const cb = new CircuitBreaker({
      threshold: 1,
      resetTimeout: 50,
      onOpen: () => { throw new Error("onOpen crashed"); },
      onHalfOpen: () => { throw new Error("onHalfOpen crashed"); },
      onClose: () => { throw new Error("onClose crashed"); },
    });
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
    await delay(60);
    await cb.call(resolveFn("ok"));
    expect(cb.state).toBe("closed");
  });
});

describe("Rolling Window", () => {
  test("rolling window is disabled by default", () => {
    const cb = new CircuitBreaker();
    const s = cb.stats();
    expect(s.rollingFailureRate).toBeUndefined();
    expect(s.rollingCallsInWindow).toBeUndefined();
    expect(s.failureRateThreshold).toBeUndefined();
  });

  test("opens circuit when failure rate exceeds threshold", async () => {
    const cb = new CircuitBreaker({
      failureRateThreshold: 0.5,
      rollingWindow: 5000,
      minimumCalls: 4,
    });
    await cb.call(resolveFn("ok"));
    await cb.call(resolveFn("ok"));
    try { await cb.call(rejectFn()); } catch { }
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
  });

  test("does not open below minimumCalls even if rate is high", async () => {
    const cb = new CircuitBreaker({
      failureRateThreshold: 0.5,
      rollingWindow: 5000,
      minimumCalls: 10,
    });
    try { await cb.call(rejectFn()); } catch { }
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("closed");
  });

  test("does not open when failure rate is below threshold", async () => {
    const cb = new CircuitBreaker({
      failureRateThreshold: 0.8,
      rollingWindow: 5000,
      minimumCalls: 3,
    });
    await cb.call(resolveFn("ok"));
    await cb.call(resolveFn("ok"));
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("closed");
  });

  test("stats include rolling window data when enabled", async () => {
    const cb = new CircuitBreaker({
      failureRateThreshold: 0.5,
      rollingWindow: 5000,
      minimumCalls: 3,
    });
    await cb.call(resolveFn("ok"));
    try { await cb.call(rejectFn()); } catch { }
    await cb.call(resolveFn("ok"));
    const s = cb.stats();
    expect(s.failureRateThreshold).toBe(0.5);
    expect(s.rollingCallsInWindow).toBe(3);
    expect(s.rollingFailureRate).toBeCloseTo(1 / 3, 1);
  });

  test("rolling window resets with reset()", async () => {
    const cb = new CircuitBreaker({
      failureRateThreshold: 0.5,
      rollingWindow: 5000,
      minimumCalls: 3,
    });
    await cb.call(resolveFn("ok"));
    try { await cb.call(rejectFn()); } catch { }
    await cb.reset();
    const s = cb.stats();
    expect(s.rollingCallsInWindow).toBe(0);
  });

  test("rolling window prunes old entries", async () => {
    const cb = new CircuitBreaker({
      failureRateThreshold: 0.1,
      rollingWindow: 100,
      minimumCalls: 1,
    });
    await cb.call(resolveFn("ok"));
    await delay(120);
    try { await cb.call(rejectFn()); } catch { }
    const s = cb.stats();
    expect(s.rollingCallsInWindow).toBe(1);
    expect(s.rollingFailureRate).toBe(1);
  });

  test("constructor validates failureRateThreshold", () => {
    expect(() => new CircuitBreaker({ failureRateThreshold: -0.1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureRateThreshold: 1.5 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ failureRateThreshold: NaN })).toThrow(RangeError);
  });

  test("constructor validates rollingWindow", () => {
    expect(() => new CircuitBreaker({ rollingWindow: 50 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ rollingWindow: NaN })).toThrow(RangeError);
  });

  test("constructor validates minimumCalls", () => {
    expect(() => new CircuitBreaker({ minimumCalls: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ minimumCalls: NaN })).toThrow(RangeError);
  });

  test("rolling window works with consecutive threshold (both trip)", async () => {
    const cb = new CircuitBreaker({
      threshold: 5,
      failureRateThreshold: 0.5,
      rollingWindow: 5000,
      minimumCalls: 4,
    });
    await cb.call(resolveFn("ok"));
    await cb.call(resolveFn("ok"));
    try { await cb.call(rejectFn()); } catch { }
    try { await cb.call(rejectFn()); } catch { }
    expect(cb.state).toBe("open");
    expect(cb.stats().rollingFailureRate).toBe(0.5);
  });
});
