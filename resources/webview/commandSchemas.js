/*
 * Follow instructions in copilot-instructions.md exactly.
 */

export const COMMAND_SCHEMA_DEFINITIONS = Object.freeze({
  generateDigest: Object.freeze({
    type: "object",
    allowUnknown: false,
    properties: Object.freeze({
      selectedFiles: Object.freeze({
        type: "array",
        required: true,
        maxLength: 5000,
        items: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 4096,
          pattern: "^[^<>:\"|?*\\\\$]+$"
        })
      }),
      outputFormat: Object.freeze({
        type: "enum",
        enum: Object.freeze(["markdown", "json", "text"])
      }),
      redactionOverride: Object.freeze({
        type: "boolean"
      })
    })
  }),
  updateSelection: Object.freeze({
    type: "object",
    allowUnknown: false,
    properties: Object.freeze({
      filePath: Object.freeze({
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 4096,
        pattern: "^[^<>:\"|?*\\\\$]+$"
      }),
      selected: Object.freeze({
        type: "boolean",
        required: true
      })
    })
  }),
  toggleRedactionOverride: Object.freeze({
    type: "object",
    allowUnknown: true,
    properties: Object.freeze({
      enabled: Object.freeze({
        type: "boolean"
      })
    })
  }),
  applyPreset: Object.freeze({
    type: "object",
    allowUnknown: false,
    properties: Object.freeze({
      presetId: Object.freeze({
        type: "string",
        maxLength: 256,
        default: "default",
        transform: (value) => (value && value.length > 0 ? value : "default")
      })
    })
  }),
  loadRemoteRepo: Object.freeze({
    type: "object",
    allowUnknown: false,
    properties: Object.freeze({
      repoUrl: Object.freeze({
        type: "string",
        required: true,
        minLength: 1,
        maxLength: 2048,
        pattern: "^https://github\\.com/[\\w\\-.]+/[\\w\\-.]+(?:\\.git)?$"
      }),
      ref: Object.freeze({
        type: "string",
        maxLength: 128,
        pattern: "^[\\w\\-./_]+$"
      }),
      sparsePaths: Object.freeze({
        type: "array",
        maxLength: 200,
        items: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 4096
        })
      })
    })
  })
});
