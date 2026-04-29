import { describe, expect, it } from "@jest/globals";
import { asyncPool } from "../utils/asyncPool";

describe("asyncPool", () => {
  it("honors concurrency limits and preserves task order", async () => {
    const concurrencyRecord: number[] = [];
    let active = 0;

    const tasks = Array.from({ length: 4 }, (_, index) => async () => {
      active++;
      concurrencyRecord.push(active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return index * 2;
    });

    const results = await asyncPool(tasks, 2);

    expect(results).toEqual([0, 2, 4, 6]);
    expect(Math.max(...concurrencyRecord)).toBeLessThanOrEqual(2);
  });

  it("propagates the first task error", async () => {
    const tasks = [
      () => Promise.resolve("ok"),
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve("ignored")
    ];

    await expect(asyncPool(tasks, 3)).rejects.toThrow("boom");
  });
});