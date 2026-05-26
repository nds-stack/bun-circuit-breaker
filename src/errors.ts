export class CircuitBreakerOpenError extends Error {
  readonly code = 'CIRCUIT_BREAKER_OPEN' as const;

  constructor(message?: string) {
    super(message ?? 'Circuit breaker is open');
    this.name = 'CircuitBreakerOpenError';
  }
}
