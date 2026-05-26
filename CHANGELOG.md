# Changelog

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
