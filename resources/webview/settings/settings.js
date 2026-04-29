(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const fields = Array.from(document.querySelectorAll("[data-section][data-key]"));

  function normalizeValue(field) {
    if (field.type === "checkbox") {
      return field.checked;
    }

    if (field.tagName === "TEXTAREA") {
      return field.value
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    if (field.type === "number") {
      return Number(field.value);
    }

    return field.value;
  }

  function setFieldValue(field, value) {
    if (field.type === "checkbox") {
      field.checked = Boolean(value);
      return;
    }

    if (field.tagName === "TEXTAREA") {
      field.value = Array.isArray(value) ? value.join("\n") : "";
      return;
    }

    field.value = value == null ? "" : String(value);
  }

  fields.forEach((field) => {
    field.addEventListener("change", () => {
      vscode.postMessage({
        type: "update-setting",
        payload: {
          section: field.dataset.section,
          key: field.dataset.key,
          value: normalizeValue(field)
        }
      });
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type !== "settings-state") {
      return;
    }

    const settings = message.payload || {};
    fields.forEach((field) => {
      const key = field.dataset.key;
      setFieldValue(field, settings[key]);
    });
  });
})();
