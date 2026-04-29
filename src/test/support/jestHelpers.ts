import { jest } from "@jest/globals";

export function createJestFn<T extends (...args: never[]) => unknown>(): jest.Mock<T> {
  return jest.fn<T>();
}