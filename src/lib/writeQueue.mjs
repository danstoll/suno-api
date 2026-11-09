const DEFAULT_MAX_WAIT_S = 120;
const DEFAULT_FLOW_MAX_S = 600;
const RUN_MARGIN_S = 60;

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Cap on one running write: WRITE_QUEUE_MAX_RUN_S, else CAPTCHA_FLOW_MAX_S (600) + 60s margin. */
function defaultMaxRunMs() {
  const s =
    positive(process.env.WRITE_QUEUE_MAX_RUN_S) ??
    (positive(process.env.CAPTCHA_FLOW_MAX_S) ?? DEFAULT_FLOW_MAX_S) + RUN_MARGIN_S;
  return s * 1000;
}

/** Waiter limit: WRITE_QUEUE_MAX_WAIT_S, else 120. Never below the run cap. */
function defaultMaxWaitMs(maxRunMs) {
  const s = positive(process.env.WRITE_QUEUE_MAX_WAIT_S) ?? DEFAULT_MAX_WAIT_S;
  return Math.max(s * 1000, maxRunMs);
}

/**
 * A promise queue that runs one task at a time, in the order submitted.
 * A task that throws rejects only its own caller; the queue carries on.
 *
 * - `maxWaitMs`: a task that has not STARTED within this time of being
 *   submitted rejects with a timeout error and never runs. Default is at
 *   least `maxRunMs`, so a write behind a long generate is not rejected early.
 * - `maxRunMs`: a running task that has not settled within this time rejects
 *   its caller with a timeout error and the queue moves on. The hung task
 *   itself cannot be cancelled; it is abandoned. Default follows
 *   CAPTCHA_FLOW_MAX_S plus a margin (WRITE_QUEUE_MAX_RUN_S overrides).
 */
export function createWriteQueue({ maxRunMs = defaultMaxRunMs(), maxWaitMs } = {}) {
  if (maxWaitMs === undefined) maxWaitMs = defaultMaxWaitMs(maxRunMs);
  let tail = Promise.resolve();
  return {
    run(task) {
      let finished;
      const done = new Promise((r) => (finished = r));
      const result = new Promise((resolve, reject) => {
        let started = false;
        let timedOut = false;
        const waitTimer = setTimeout(() => {
          if (started) return;
          timedOut = true;
          reject(
            new Error(
              `Write queue timeout: waited over ${maxWaitMs}ms behind an earlier write`
            )
          );
        }, maxWaitMs);
        tail.then(() => {
          clearTimeout(waitTimer);
          if (timedOut) return finished();
          started = true;
          const runTimer = setTimeout(() => {
            reject(
              new Error(
                `Write queue timeout: write ran over ${maxRunMs}ms and was released`
              )
            );
            finished();
          }, maxRunMs);
          return Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .then(() => {
              clearTimeout(runTimer);
              finished();
            });
        });
      });
      // A timed-out task never ran, so the next one waits on `done`, not `result`.
      tail = done;
      return result;
    }
  };
}
