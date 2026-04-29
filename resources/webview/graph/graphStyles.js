(function () {
  function css(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  window.buildCodeIngestGraphStyles = function buildCodeIngestGraphStyles() {
    return [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-size": 11,
          "text-wrap": "wrap",
          "text-max-width": 140,
          "text-valign": "center",
          "text-halign": "center",
          "background-color": css("--vscode-editor-background", "#1f1f1f"),
          color: css("--vscode-editor-foreground", "#e6e6e6"),
          "border-width": 1,
          "border-color": css("--vscode-panel-border", "#3a3a3a"),
          width: "label",
          height: 34,
          padding: "10px",
          shape: "round-rectangle"
        }
      },
      {
        selector: "node[type = 'file']",
        style: {
          shape: "round-rectangle"
        }
      },
      {
        selector: "node[type = 'function'], node[type = 'method']",
        style: {
          shape: "ellipse",
          "background-color": css("--vscode-symbolIcon-functionForeground", "#c586c0")
        }
      },
      {
        selector: "node[type = 'class']",
        style: {
          shape: "diamond",
          "background-color": css("--vscode-symbolIcon-classForeground", "#4ec9b0")
        }
      },
      {
        selector: "node[type = 'interface']",
        style: {
          shape: "hexagon",
          "background-color": css("--vscode-symbolIcon-interfaceForeground", "#dcdcaa")
        }
      },
      {
        selector: "node.current",
        style: {
          "background-color": css("--vscode-activityBarBadge-background", "#007acc"),
          "border-width": 2,
          "border-color": css("--vscode-focusBorder", "#ffffff")
        }
      },
      {
        selector: "node.selected-custom",
        style: {
          "border-width": 3,
          "border-color": css("--vscode-editorInfo-foreground", "#75beff")
        }
      },
      {
        selector: "node.dimmed",
        style: {
          opacity: Number.parseFloat(css("--code-ingest-focus-opacity", "0.15")) || 0.15
        }
      },
      {
        selector: "edge",
        style: {
          width: 2,
          "curve-style": "bezier",
          "line-color": css("--vscode-editorInfo-foreground", "#75beff"),
          "target-arrow-color": css("--vscode-editorInfo-foreground", "#75beff"),
          "target-arrow-shape": "triangle"
        }
      },
      {
        selector: "edge[type = 'call']",
        style: {
          "line-style": "dashed",
          "line-color": css("--vscode-editorWarning-foreground", "#f2cc60"),
          "target-arrow-color": css("--vscode-editorWarning-foreground", "#f2cc60")
        }
      },
      {
        selector: "edge[type = 'inheritance']",
        style: {
          "target-arrow-shape": "diamond",
          "line-color": css("--vscode-symbolIcon-classForeground", "#4ec9b0"),
          "target-arrow-color": css("--vscode-symbolIcon-classForeground", "#4ec9b0")
        }
      },
      {
        selector: "edge[type = 'implements']",
        style: {
          "line-style": "dotted",
          "line-color": css("--vscode-symbolIcon-interfaceForeground", "#dcdcaa"),
          "target-arrow-color": css("--vscode-symbolIcon-interfaceForeground", "#dcdcaa")
        }
      },
      {
        selector: "edge[type = 'contains']",
        style: {
          width: 1,
          "line-style": "dotted",
          "line-color": css("--vscode-editor-inactiveSelectionBackground", "#555")
        }
      },
      {
        selector: "edge.circular",
        style: {
          "line-style": "dashed",
          "line-color": css("--vscode-editorError-foreground", "#f14c4c"),
          "target-arrow-color": css("--vscode-editorError-foreground", "#f14c4c")
        }
      },
      {
        selector: "edge.dimmed",
        style: {
          opacity: 0.1
        }
      }
    ];
  };
})();
