/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const validatePayload = createValidator({
  type: "object",
  properties: {
    repoUrl: { type: "string", required: true, maxLength: 2048 },
    tmpDir: { type: "string", maxLength: 2048 },
    sha: { type: "string", required: true, maxLength: 64 },
    subpath: { type: "string", maxLength: 512 },
    warnings: { type: "array", items: { type: "string", maxLength: 1024 } }
  }
});

export class RemoteRepoLoadedHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["remoteRepoLoaded"] });
  }

  canHandle(messageType) {
    return messageType === "remoteRepoLoaded";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    this.store.setState({
      remoteRepo: {
        repoUrl: payload.repoUrl,
        tmpDir: payload.tmpDir,
        sha: payload.sha,
        subpath: payload.subpath
      }
    });

    this.uiRenderer.showRepoMetadata(payload);
    this.uiRenderer.enableIngestActions(true);

    if (payload.warnings && payload.warnings.length > 0) {
      this.uiRenderer.showRecoverableError({
        title: "Repository warnings",
        message: payload.warnings.join(" · ")
      });
    } else {
      this.uiRenderer.clearRecoverableError();
    }
  }
}
