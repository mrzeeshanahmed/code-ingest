import { describe, expect, it } from "@jest/globals";

import { COMMAND_MAP as HOST_COMMAND_MAP } from "../../../commands/commandMap";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore generated JS module without type declarations
import { COMMAND_MAP as WEBVIEW_COMMAND_MAP } from "../../../../resources/webview/commandMap.generated.js";

function toSortedSet(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

describe("command map consistency", () => {
  it("keeps WEBVIEW_TO_HOST command identifiers aligned", () => {
    const hostCommands = toSortedSet(Object.values(HOST_COMMAND_MAP.WEBVIEW_TO_HOST));
    const webviewCommands = toSortedSet(Object.values(WEBVIEW_COMMAND_MAP.WEBVIEW_TO_HOST));

    expect(hostCommands).toEqual(webviewCommands);
  });

  it("keeps HOST_TO_WEBVIEW command identifiers aligned", () => {
    const hostCommands = toSortedSet(Object.values(HOST_COMMAND_MAP.HOST_TO_WEBVIEW));
    const webviewCommands = toSortedSet(Object.values(WEBVIEW_COMMAND_MAP.HOST_TO_WEBVIEW));

    expect(hostCommands).toEqual(webviewCommands);
  });
});
