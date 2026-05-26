import { CircuitBreakerOpenError } from "./errors.js";

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  threshold?: number;
  resetTimeout?: number;
  successThreshold?: number;
  onOpen?: () => void;
  onHalfOpen?: () => void;
  onClose?: () => void;
  failureRateThreshold?: number;
  rollingWindow?: number;
  minimumCalls?: number;
  maxPending?: number;
}

export interface CircuitStats {
  state: CircuitState;
  successCount: number;
  failureCount: number;
  totalCalls: number;
  openCount: number;
  lastFailure?: { error: string; timestamp: number };
  lastSuccess?: { timestamp: number };
  uptime: number;
  rollingFailureRate?: number;
  rollingCallsInWindow?: number;
  failureRateThreshold?: number;
}

export type EventName = 'open' | 'close' | 'half-open';

interface InternalOptions {
  threshold: number;
  resetTimeout: number;
  successThreshold: number;
  onOpen: (() => void) | null;
  onHalfOpen: (() => void) | null;
  onClose: (() => void) | null;
  failureRateThreshold: number;
  rollingWindow: number;
  minimumCalls: number;
  maxPending: number;
}

interface RollingBucket {
  t: number;
  fail: number;
  total: number;
}

export class CircuitBreaker {
  #state: CircuitState = 'closed';
  #failureCount = 0;
  #consecutiveFailures = 0;
  #successCount = 0;
  #halfOpenSuccesses = 0;
  #totalCalls = 0;
  #openCount = 0;
  #lastFailure: { error: string; timestamp: number } | undefined;
  #lastSuccess: { timestamp: number } | undefined;
  #startTime: number;
  #lastOpenTime = 0;
  #opts: InternalOptions;
  #mutex: Promise<void> = Promise.resolve();
  #pending = 0;
  #listeners = new Map<EventName, Set<() => void>>();
  #rollingBuckets: RollingBucket[] = [];
  #bucketSpan: number;
  #maxListeners = 100;

  constructor(options: CircuitBreakerOptions = {}) {

    const threshold = options.threshold ?? 5;
    const resetTimeout = options.resetTimeout ?? 30000;
    const successThreshold = options.successThreshold ?? 1;
    const failureRateThreshold = options.failureRateThreshold ?? 0;
    const rollingWindow = options.rollingWindow ?? 10000;
    const minimumCalls = options.minimumCalls ?? 10;
    const maxPending = options.maxPending ?? 1000;

    if (threshold < 0 || !Number.isFinite(threshold)) {
      throw new RangeError(`CircuitBreaker: threshold must be >= 0, got ${threshold}`);
    }
    if (resetTimeout < 0 || !Number.isFinite(resetTimeout)) {
      throw new RangeError(`CircuitBreaker: resetTimeout must be >= 0, got ${resetTimeout}`);
    }
    if (successThreshold < 1 || !Number.isFinite(successThreshold)) {
      throw new RangeError(`CircuitBreaker: successThreshold must be >= 1, got ${successThreshold}`);
    }
    if (failureRateThreshold !== 0 && (failureRateThreshold <= 0 || failureRateThreshold >= 1 || !Number.isFinite(failureRateThreshold))) {
      throw new RangeError(`CircuitBreaker: failureRateThreshold must be between 0 and 1 (exclusive), got ${failureRateThreshold}`);
    }
    if (rollingWindow < 100 || !Number.isFinite(rollingWindow)) {
      throw new RangeError(`CircuitBreaker: rollingWindow must be >= 100ms, got ${rollingWindow}`);
    }
    if (minimumCalls < 1 || !Number.isFinite(minimumCalls)) {
      throw new RangeError(`CircuitBreaker: minimumCalls must be >= 1, got ${minimumCalls}`);
    }
    if (maxPending < 1 || !Number.isFinite(maxPending)) {
      throw new RangeError(`CircuitBreaker: maxPending must be >= 1, got ${maxPending}`);
    }

    this.#opts = {
      threshold,
      resetTimeout,
      successThreshold,
      onOpen: options.onOpen ?? null,
      onHalfOpen: options.onHalfOpen ?? null,
      onClose: options.onClose ?? null,
      failureRateThreshold,
      rollingWindow,
      minimumCalls,
      maxPending,
    };
    this.#bucketSpan = Math.max(100, Math.floor(this.#opts.rollingWindow / 10));
    this.#startTime = performance.now();
  }

  get state(): CircuitState {
    return this.#state;
  }

  get isOpen(): boolean {
    return this.#state === 'open';
  }

  get isHalfOpen(): boolean {
    return this.#state === 'half-open';
  }

  get isClosed(): boolean {
    return this.#state === 'closed';
  }

  stats(): CircuitStats {
    const rollingStats = this.#getRollingStats();
    const result: CircuitStats = {
      state: this.#state,
      successCount: this.#successCount,
      failureCount: this.#failureCount,
      totalCalls: this.#totalCalls,
      openCount: this.#openCount,
      lastFailure: this.#lastFailure ? { ...this.#lastFailure } : undefined,
      lastSuccess: this.#lastSuccess ? { ...this.#lastSuccess } : undefined,
      uptime: performance.now() - this.#startTime,
    };
    if (this.#opts.failureRateThreshold > 0) {
      result.rollingFailureRate = rollingStats.rate;
      result.rollingCallsInWindow = rollingStats.total;
      result.failureRateThreshold = this.#opts.failureRateThreshold;
    }
    return result;
  }

  async forceOpen(): Promise<void> {
    return this.#synchronized(async () => {
      this.#transitionTo('open');
    });
  }

  async forceClose(): Promise<void> {
    return this.#synchronized(async () => {
      this.#transitionTo('closed');
    });
  }

  async reset(): Promise<void> {
    return this.#synchronized(async () => {
      this.#state = 'closed';
      this.#failureCount = 0;
      this.#consecutiveFailures = 0;
      this.#successCount = 0;
      this.#halfOpenSuccesses = 0;
      this.#totalCalls = 0;
      this.#openCount = 0;
      this.#lastFailure = undefined;
      this.#lastSuccess = undefined;
      this.#startTime = performance.now();
      this.#lastOpenTime = 0;
      this.#listeners.clear();
      this.#rollingBuckets = [];
      this.#pending = 0;
      this.#mutex = Promise.resolve();
    });
  }

  on(event: EventName, handler: () => void): void {
    if (typeof handler !== "function") throw new TypeError("CircuitBreaker.on(): handler must be a function");
    const existing = this.#listeners.get(event);
    if (existing) {
      if (existing.size >= this.#maxListeners) {
        console.warn(`CircuitBreaker: max listeners (${this.#maxListeners}) exceeded for "${event}" — call not registered`);
        return;
      }
      existing.add(handler);
    } else {
      this.#listeners.set(event, new Set([handler]));
    }
  }

  off(event: EventName, handler: () => void): void {
    if (typeof handler !== "function") throw new TypeError("CircuitBreaker.off(): handler must be a function");
    const existing = this.#listeners.get(event);
    if (existing) {
      existing.delete(handler);
      if (existing.size === 0) {
        this.#listeners.delete(event);
      }
    }
  }

  removeAllListeners(event?: EventName): void {
    if (event) {
      this.#listeners.delete(event);
    } else {
      this.#listeners.clear();
    }
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    return this.#synchronized(async () => {
      if (this.#state === 'open') {
        const elapsed = performance.now() - this.#lastOpenTime;
        if (elapsed >= this.#opts.resetTimeout) {
          this.#transitionTo('half-open');
        } else {
          throw new CircuitBreakerOpenError(
            `Circuit breaker is open (reset in ${Math.ceil((this.#opts.resetTimeout - elapsed) / 1000)}s)`
          );
        }
      }

      this.#totalCalls++;
      try {
        const result = await fn();
        this.#onSuccess();
        return result;
      } catch (error) {
        this.#onFailure(error);
        throw error;
      }
    });
  }

  // promise-chain mutex — cannot use async/await; need to chain onto prev promise
  // #pending check is synchronous (outside chain) — safe in single-threaded JS
  #synchronized<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.#opts.maxPending) {
      return Promise.reject(new CircuitBreakerOpenError(
        `Circuit breaker queue full (max ${this.#opts.maxPending} pending)`
      ));
    }
    this.#pending++;
    const prev = this.#mutex;
    let release: () => void;
    this.#mutex = new Promise<void>(resolve => { release = resolve; });
    return prev.then(() => fn()).finally(() => { this.#pending--; release!(); });
  }

  #transitionTo(state: CircuitState): void {
    if (this.#state === state) return;
    this.#setState(state);
  }

  #setState(state: CircuitState): void {
    this.#state = state;

    if (state === 'open') {
      this.#openCount++;
      this.#lastOpenTime = performance.now();
      this.#safeCallback(this.#opts.onOpen, 'onOpen');
      this.#emit('open');
    } else if (state === 'closed') {
      this.#consecutiveFailures = 0;
      this.#halfOpenSuccesses = 0;
      this.#safeCallback(this.#opts.onClose, 'onClose');
      this.#emit('close');
    } else if (state === 'half-open') {
      this.#halfOpenSuccesses = 0;
      this.#safeCallback(this.#opts.onHalfOpen, 'onHalfOpen');
      this.#emit('half-open');
    }
  }

  #safeCallback(fn: (() => void) | null, name: string): void {
    if (!fn) return;
    try { fn(); } catch (e) {
      console.warn(`CircuitBreaker: "${name}" callback error:`, e);
    }
  }

  #emit(event: EventName): void {
    const handlers = this.#listeners.get(event);
    if (!handlers) return;
    for (const h of [...handlers]) {
      try { h(); } catch (e) {
        console.warn(`CircuitBreaker: event handler error for "${event}":`, e);
      }
    }
  }

  #onSuccess(): void {
    this.#successCount++;
    this.#lastSuccess = { timestamp: performance.now() };
    this.#recordRolling(true);

    if (this.#state === 'half-open') {
      this.#halfOpenSuccesses++;
      if (this.#halfOpenSuccesses >= this.#opts.successThreshold) {
        this.#transitionTo('closed');
      }
      return;
    }

    if (this.#state === 'closed') {
      this.#consecutiveFailures = 0;
    }
  }

  #onFailure(error: unknown): void {
    this.#failureCount++;
    this.#lastFailure = {
      error: error instanceof Error ? error.message : String(error),
      timestamp: performance.now(),
    };
    this.#recordRolling(false);

    if (this.#state === 'half-open') {
      this.#transitionTo('open');
      return;
    }

    if (this.#state === 'closed') {
      this.#consecutiveFailures++;
      if (this.#consecutiveFailures >= this.#opts.threshold) {
        this.#transitionTo('open');
        return;
      }
      if (this.#opts.failureRateThreshold > 0 && this.#checkRollingFailureRate()) {
        this.#transitionTo('open');
        return;
      }
    }
  }

  #recordRolling(success: boolean): void {
    if (this.#opts.failureRateThreshold <= 0) return;
    const now = performance.now();
    this.#pruneRolling(now);
    const lastBucket = this.#rollingBuckets[this.#rollingBuckets.length - 1];
    if (!lastBucket || now - lastBucket.t >= this.#bucketSpan) {
      this.#rollingBuckets.push({ t: now, fail: 0, total: 0 });
    }
    const bucket = this.#rollingBuckets[this.#rollingBuckets.length - 1];
    if (bucket) {
      bucket.total++;
      if (!success) bucket.fail++;
    }
  }

  #pruneRolling(now?: number): void {
    const cutoff = (now ?? performance.now()) - this.#opts.rollingWindow;
    while (this.#rollingBuckets.length > 0 && this.#rollingBuckets[0]!.t < cutoff) {
      this.#rollingBuckets.shift();
    }
  }

  #checkRollingFailureRate(): boolean {
    this.#pruneRolling();
    let totalFail = 0;
    let totalCalls = 0;
    for (const b of this.#rollingBuckets) {
      totalFail += b.fail;
      totalCalls += b.total;
    }
    return totalCalls >= this.#opts.minimumCalls && (totalFail / totalCalls) >= this.#opts.failureRateThreshold;
  }

  #getRollingStats(): { rate: number; total: number } {
    if (this.#opts.failureRateThreshold <= 0) return { rate: 0, total: 0 };
    this.#pruneRolling();
    let totalFail = 0;
    let totalCalls = 0;
    for (const b of this.#rollingBuckets) {
      totalFail += b.fail;
      totalCalls += b.total;
    }
    return { rate: totalCalls > 0 ? totalFail / totalCalls : 0, total: totalCalls };
  }
}
