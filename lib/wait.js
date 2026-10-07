export function waitForRetry(delayMs) {
  return new Promise((resolve) => {
    const finish = (interrupted) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      resolve(interrupted);
    };
    const onInterrupt = () => finish(true);
    const timer = setTimeout(() => finish(false), delayMs);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
  });
}
