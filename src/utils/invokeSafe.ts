/**
 * Fire-and-forget IPC wrapper. Returns the resolved value on success,
 * or the supplied `fallback` on any thrown error (logged via
 * `console.warn` with `[<label>] failed:` prefix).
 *
 * Use ONLY for calls where:
 *   - the result is non-essential enrichment (e.g. file size for
 *     EXIF formatting; in-flight progress pings),
 *   - failure is recoverable by falling back to a default,
 *   - the caller has no useful error-handling beyond "swallow it".
 *
 * Do NOT use when:
 *   - the error must propagate to a UI toast / error boundary,
 *   - the error is part of business logic (delete / write paths),
 *   - you need access to the `Error` object for branching.
 *
 * The `op` is passed as a thunk so the IPC is only invoked when this
 * helper actually runs (vs. eagerly firing on the call site). This
 * matters when `invokeSafe` is the only reference holding the IPC
 * promise — without the thunk, the IPC would start even on a code
 * path that later short-circuited.
 */
export async function invokeSafe<T>(
  op: () => Promise<T>,
  fallback: T,
  label: string,
): Promise<T> {
  try {
    return await op();
  } catch (e) {
    console.warn(`[${label}] failed:`, e);
    return fallback;
  }
}
