/** Injectable clock interface for deterministic testing of time-dependent logic. */
export interface Clock {
  now(): number;
  isoNow(): string;
}

/** Default clock backed by system time. */
export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

/** Controllable clock for deterministic tests. */
export interface TestClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
  currentMs(): number;
}

/** Create a controllable clock for tests. */
export function createTestClock(startMs: number = 1767225600000): TestClock {
  let ms = startMs;
  return {
    now: () => ms,
    isoNow: () => new Date(ms).toISOString(),
    advance(delta: number) { ms += delta; },
    set(value: number) { ms = value; },
    currentMs: () => ms,
  };
}
