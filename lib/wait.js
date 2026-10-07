export function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (interrupted) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      signal?.removeEventListener("abort", onInterrupt);
      resolve(interrupted);
    };
    const onInterrupt = () => finish(true);
    const timer = setTimeout(() => finish(false), delayMs);
    if (signal) signal.addEventListener("abort", onInterrupt, { once: true });
    else {
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onInterrupt);
    }
  });
}
