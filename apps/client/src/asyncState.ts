/** Ignore stale session loads without settling a replacement request's state. */
export function observeCurrent<T>(operation: Promise<T>, current: () => boolean,
  accept: (value: T) => void, reject: (error: unknown) => void, settled: () => void) {
  void operation.then(value => { if (current()) accept(value); })
    .catch(error => { if (current()) reject(error); })
    .finally(() => { if (current()) settled(); });
}
