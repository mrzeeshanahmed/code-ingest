export type CommandPayloadValidator = (
  commandId: string,
  payload: unknown
) =>
  | { ok: true; value: unknown }
  | { ok: false; reason?: string; errors?: unknown }
  | undefined;

let validatorPromise: Promise<CommandPayloadValidator> | undefined;

async function importValidatorModule(): Promise<CommandPayloadValidator> {
  // @ts-expect-error command validation helper is provided as a compiled JS asset under resources/
  const module = await import("../../resources/webview/commandValidation.js");
  const candidate = (module as { validateCommandPayload?: CommandPayloadValidator }).validateCommandPayload;
  if (typeof candidate !== "function") {
    throw new Error("commandValidation module is missing validateCommandPayload export");
  }
  return candidate;
}

export async function loadCommandValidator(): Promise<CommandPayloadValidator> {
  if (!validatorPromise) {
    validatorPromise = importValidatorModule().catch((error) => {
      validatorPromise = undefined;
      throw error;
    });
  }
  return validatorPromise;
}