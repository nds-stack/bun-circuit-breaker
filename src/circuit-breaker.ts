import { CircuitBreakerOpenError } from "./errors.js";

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  threshold?: number;
  resetTimeout?: number;
  successThreshold?: number;
  onOpen?: () => void;
  onHalfOpen?: () => void;
  onClose?: () => void;
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
}

type EventName = 'open' | 'close' | 'half-open';

interface InternalOptions {
  threshold: number;
  resetTimeout: number;
  successThreshold: number;
  onOpen: (() => void) | null;
  onHalfOpen: (() => void) | null;
  onClose: (() => void) | null;
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
  #listeners = new Map<EventName, Set<() => void>>();

  constructor(options: CircuitBreakerOptions = {}) {
    const threshold = options.threshold ?? 5;
    const resetTimeout = options.resetTimeout ?? 30000;
    const successThreshold = options.successThreshold ?? 1;

    if (threshold < 0 || !Number.isFinite(threshold)) {
      throw new RangeError(`CircuitBreaker: threshold must be >= 0, got ${threshold}`);
    }
    if (resetTimeout < 0 || !Number.isFinite(resetTimeout)) {
      throw new RangeError(`CircuitBreaker: resetTimeout must be >= 0, got ${resetTimeout}`);
    }
    if (successThreshold < 1 || !Number.isFinite(successThreshold)) {
      throw new RangeError(`CircuitBreaker: successThreshold must be >= 1, got ${successThreshold}`);
    }

    this.#opts = {
      threshold,
      resetTimeout,
      successThreshold,
      onOpen: options.onOpen ?? null,
      onHalfOpen: options.onHalfOpen ?? null,
      onClose: options.onClose ?? null,
    };
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
    return {
      state: this.#state,
      successCount: this.#successCount,
      failureCount: this.#failureCount,
      totalCalls: this.#totalCalls,
      openCount: this.#openCount,
      lastFailure: this.#lastFailure ? { ...this.#lastFailure } : undefined,
      lastSuccess: this.#lastSuccess ? { ...this.#lastSuccess } : undefined,
      uptime: performance.now() - this.#startTime,
    };
  }

  async forceOpen(): Promise<void> {
    return this.#synchronized(async () => {
      this.#setState('open');
    });
  }

  async forceClose(): Promise<void> {
    return this.#synchronized(async () => {
      this.#setState('closed');
    });
  }

  reset(): void {
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
  }

  on(event: EventName, handler: () => void): void {
    const existing = this.#listeners.get(event);
    if (existing) {
      existing.add(handler);
    } else {
      this.#listeners.set(event, new Set([handler]));
    }
  }

  off(event: EventName, handler: () => void): void {
    const existing = this.#listeners.get(event);
    if (existing) {
      existing.delete(handler);
      if (existing.size === 0) {
        this.#listeners.delete(event);
      }
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

  #synchronized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#mutex;
    let release: () => void;
    this.#mutex = new Promise<void>(resolve => { release = resolve; });
    return prev.then(() => fn()).finally(() => release!());
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
      this.#opts.onOpen?.();
      this.#emit('open');
    } else if (state === 'closed') {
      this.#consecutiveFailures = 0;
      this.#halfOpenSuccesses = 0;
      this.#opts.onClose?.();
      this.#emit('close');
    } else if (state === 'half-open') {
      this.#halfOpenSuccesses = 0;
      this.#opts.onHalfOpen?.();
      this.#emit('half-open');
    }
  }

  #emit(event: EventName): void {
    const handlers = this.#listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(); } catch (e) {
        console.warn(`CircuitBreaker: event handler error for "${event}":`, e);
      }
    }
  }

  #onSuccess(): void {
    this.#successCount++;
    this.#lastSuccess = { timestamp: performance.now() };

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

    if (this.#state === 'half-open') {
      this.#transitionTo('open');
      return;
    }

    if (this.#state === 'closed') {
      this.#consecutiveFailures++;
      if (this.#consecutiveFailures >= this.#opts.threshold) {
        this.#transitionTo('open');
      }
    }
  }
}
