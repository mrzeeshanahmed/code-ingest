import { afterAll, beforeEach } from "@jest/globals";
import vscodeMock from "./__mocks__/vscode";

beforeEach(() => {
	if (typeof vscodeMock.__reset === "function") {
		vscodeMock.__reset();
	}
});

afterAll(() => {
	if (typeof vscodeMock.__reset === "function") {
		vscodeMock.__reset();
	}
});