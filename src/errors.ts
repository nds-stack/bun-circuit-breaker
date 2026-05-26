export class CircuitBreakerOpenError extends Error {
  readonly code = 'CIRCUIT_BREAKER_OPEN' as const;

  constructor(message?: string) {
    super(message ?? 'Circuit breaker is open');
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreakerQueueFullError extends Error {
  readonly code = 'CIRCUIT_BREAKER_QUEUE_FULL' as const;

  constructor(message?: string) {
    super(message ?? 'Circuit breaker queue full');
    this.name = 'CircuitBreakerQueueFullError';
  }
}
