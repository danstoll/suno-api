/**
 * A promise queue that runs one task at a time, in the order submitted.
 * A task that throws rejects only its own caller; the queue carries on.
 */
export function createWriteQueue() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
  };
}
