const DEFAULT_MAX_WAIT_S = 120;

function defaultMaxWaitMs() {
  const s = Number(process.env.WRITE_QUEUE_MAX_WAIT_S);
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_MAX_WAIT_S) * 1000;
}

/**
 * A promise queue that runs one task at a time, in the order submitted.
 * A task that throws rejects only its own caller; the queue carries on.
 *
 * A task that has not STARTED within `maxWaitMs` of being submitted rejects
 * with a timeout error and never runs; the queue moves on to the next task.
 * The limit covers waiting only: a task that is already running is not cut
 * short. Default: WRITE_QUEUE_MAX_WAIT_S seconds, else 120.
 */
export function createWriteQueue({ maxWaitMs = defaultMaxWaitMs() } = {}) {
  let tail = Promise.resolve();
  return {
    run(task) {
      let finished;
      const done = new Promise((r) => (finished = r));
      const result = new Promise((resolve, reject) => {
        let started = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          if (started) return;
          timedOut = true;
          reject(
            new Error(
              `Write queue timeout: waited over ${maxWaitMs}ms behind an earlier write`
            )
          );
        }, maxWaitMs);
        tail.then(() => {
          clearTimeout(timer);
          if (timedOut) return finished();
          started = true;
          return Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .then(finished);
        });
      });
      // A timed-out task never ran, so the next one waits on `done`, not `result`.
      tail = done;
      return result;
    }
  };
}
