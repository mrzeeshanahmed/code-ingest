export async function asyncPool<T>(
  taskFactories: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const results: T[] = new Array(taskFactories.length);
  let nextIndex = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const launchNext = () => {
      if (nextIndex >= taskFactories.length) {
        if (active === 0) {
          resolve(results);
        }
        return;
      }

      while (active < limit && nextIndex < taskFactories.length) {
        const current = nextIndex++;
        const factory = taskFactories[current];
        active++;

        Promise.resolve()
          .then(factory)
          .then((value) => {
            results[current] = value;
            active--;
            launchNext();
          })
          .catch((error) => {
            reject(error);
          });
      }
    };

    launchNext();
  });
}
