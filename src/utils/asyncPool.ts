import * as vscode from "vscode";

interface AsyncPoolOptions {
  cancellationToken?: vscode.CancellationToken;
}

export async function asyncPool<T>(
  taskFactories: Array<() => Promise<T>>,
  concurrency: number,
  options: AsyncPoolOptions = {}
): Promise<T[]> {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const results: T[] = new Array(taskFactories.length);
  let nextIndex = 0;
  let active = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const { cancellationToken } = options;

    const finalize = () => {
      cancellationListener?.dispose();
    };

    const rejectWithCancellation = () => {
      if (settled) {
        return;
      }
      settled = true;
      finalize();
      reject(new vscode.CancellationError());
    };

    const cancellationListener = cancellationToken?.onCancellationRequested(() => {
      rejectWithCancellation();
    });

    const launchNext = () => {
      if (settled) {
        return;
      }
      if (cancellationToken?.isCancellationRequested) {
        rejectWithCancellation();
        return;
      }
      if (nextIndex >= taskFactories.length) {
        if (active === 0) {
          if (settled) {
            return;
          }
          settled = true;
          finalize();
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
            if (settled) {
              return;
            }
            settled = true;
            finalize();
            reject(error);
          });
      }
    };

    launchNext();
  });
}
