/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

type AcquireVsCodeApi = () => unknown;
type WebviewApplicationConstructor = new () => unknown;

describe("WebviewApplication bootstrap", () => {
	let originalAcquire: AcquireVsCodeApi | undefined;
	let WebviewApplicationCtor: WebviewApplicationConstructor | undefined;

	beforeEach(async () => {
		document.body.innerHTML = "<div id=\"root\"></div>";
		const globalWithApi = globalThis as typeof globalThis & { acquireVsCodeApi?: AcquireVsCodeApi };
		originalAcquire = globalWithApi.acquireVsCodeApi;

		const windowWithTestFlag = window as typeof window & { __CODE_INGEST_TEST__?: boolean };
		windowWithTestFlag.__CODE_INGEST_TEST__ = true;

		const windowWithApplication = window as typeof window & { WebviewApplication?: WebviewApplicationConstructor };
		if (!windowWithApplication.WebviewApplication) {
			const loader = new Function("return import('./main.js')") as () => Promise<unknown>;
			await loader();
		}
		WebviewApplicationCtor = windowWithApplication.WebviewApplication;
	});

	afterEach(() => {
		const globalWithApi = globalThis as typeof globalThis & { acquireVsCodeApi?: AcquireVsCodeApi };
		if (originalAcquire) {
			globalWithApi.acquireVsCodeApi = originalAcquire;
		} else {
			delete globalWithApi.acquireVsCodeApi;
		}
		const windowWithTestFlag = window as typeof window & { __CODE_INGEST_TEST__?: boolean };
		delete windowWithTestFlag.__CODE_INGEST_TEST__;
		WebviewApplicationCtor = undefined;
		document.body.innerHTML = "";
	});

	it("renders an inline error banner when the VS Code API is unavailable", () => {
		const failingAcquire = () => {
			throw new Error("VS Code API missing");
		};

		const globalWithApi = globalThis as typeof globalThis & { acquireVsCodeApi?: AcquireVsCodeApi };
		const windowWithApplication = window as typeof window & { WebviewApplication?: WebviewApplicationConstructor };

		globalWithApi.acquireVsCodeApi = failingAcquire;

		const Application = (windowWithApplication.WebviewApplication ?? WebviewApplicationCtor) as WebviewApplicationConstructor;
		expect(Application).toBeDefined();
		expect(() => new Application()).toThrow("VS Code API missing");
		expect(document.body.textContent ?? "").toContain("VS Code API");
		expect(document.body.textContent ?? "").toContain("npm run build:webview");
	});
});

export {};
