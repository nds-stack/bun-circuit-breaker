# Changelog

## [0.1.0-beta.0] — 2026-05-27

### Added
- Rolling window failure counting via `failureRateThreshold`, `rollingWindow`, and `minimumCalls` options — time-based circuit opening alongside the existing consecutive threshold
- Benchmark comparison against opossum (v9.0.0) and cockatiel (v4.0.0) with real throughput data
- `CircuitStats.rollingFailureRate`, `CircuitStats.rollingCallsInWindow`, `CircuitStats.failureRateThreshold`
- Input validation for all options: threshold, resetTimeout, successThreshold, failureRateThreshold, rollingWindow, minimumCalls, maxPending, maxListeners
- `maxPending` option (default 1000) — bounds promise-chain mutex queue, prevents unbounded memory growth
- `maxListeners` option (default 100) — configurable listener limit per event
- `CircuitBreakerQueueFullError` with distinct `code: 'CIRCUIT_BREAKER_QUEUE_FULL'` — separate from `CircuitBreakerOpenError`
- `removeAllListeners(event?)` method — remove listeners for an event or all events
- `call(fn, signal?)` — optional `AbortSignal` support for cancellation
- `toJSON()` / `fromJSON()` — state serialization for serverless cold-start recovery
- `onOpen`/`onHalfOpen`/`onClose` callbacks now safely wrapped in try/catch (`#safeCallback`)

### Changed
- `#synchronized` rewritten from promise-chain mutex to **linked-list queue** — O(1) enqueue/dequeue, zero-alloc fast-path when no contention
- Timer-based half-open transition — `Bun.sleep(resetTimeout)` on open automatically transitions to half-open, eliminating `performance.now()` overhead in fast-path rejection
- `reset()` no longer clears event listeners (use `removeAllListeners()` explicitly)
- `reset()` no longer forcibly drains the queue — lets linked-list drain naturally
- `stats()` now conditionally includes rolling window fields when `failureRateThreshold` is configured
- Benchmark table now includes "Overhead vs opossum" column
- `tsconfig.json`: `noUnusedLocals` and `noUnusedParameters` set to `true`
- `.gitignore`: `bench/competitors/` → `bench/Competitor/` (casing consistency)

### Fixed
- `forceOpen()` / `forceClose()` now use `#transitionTo()` (was `#setState()` directly) — prevents double-counting openCount and re-firing events
- `#emit()` copies Set before iterating — safe against handler re-entrancy
- `on()`/`off()` validate handler is a function — throws `TypeError` otherwise
- `failureRateThreshold: 1.0` now correctly rejected (was erroneously allowed)

## [0.1.0-alpha.1] — 2026-05-26

### Added
- Input validation for constructor options (threshold, resetTimeout, successThreshold)
- `console.warn` for event handler errors (was silent-swallow)
- `#listeners.clear()` in `reset()` to prevent listener leak

### Fixed
- `forceOpen()` / `forceClose()` now async through mutex (race condition)
- `off()` cleans up empty Set entries from Map
- Missing `clean` script added
- Bench script fixed (`bun run` → `bun test`)
- Import extensions changed to `.js` for declaration file compatibility

## [0.1.0-alpha.0] — 2026-05-26

### Added
- Initial release
- CircuitBreaker class with closed/open/half-open state machine
- Configurable threshold, resetTimeout, and successThreshold
- CircuitBreakerOpenError with `code` property
- Event emitter pattern (on/off for state transitions)
- Callback options (onOpen, onHalfOpen, onClose)
- forceOpen() / forceClose() manual overrides
- reset() with full stats clear
- Stats tracking (successCount, failureCount, totalCalls, openCount, uptime)
- Zero dependencies — pure TypeScript + Bun built-in APIs
- Thread-safe via promise-chain mutex
- `performance.now()` based timing
