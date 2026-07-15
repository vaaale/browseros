// A minimal in-process async mutex: serializes read-modify-write sections so
// concurrent callers cannot interleave and lose updates. Pure (no server-only),
// so the lost-update guarantee is unit-testable. One BOS process per user, so an
// in-process lock is sufficient for the feature-context file.

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively; callers are serialized in arrival order. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive regardless of whether `fn` rejected.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
