/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const { FileTreeComponent } = require("../../components/fileTree.js");
const { TestUtils } = require("../setup.js");

describe("FileTreeComponent", () => {
  let component;
  let container;
  let props;

  beforeEach(() => {
    container = document.createElement("div");
    container.style.height = "400px";
    container.style.overflow = "auto";
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    document.body.appendChild(container);

    props = {
      nodes: [
        { name: "file1.js", type: "file", relPath: "file1.js" },
        {
          name: "src",
          type: "directory",
          relPath: "src/",
          children: [{ name: "index.js", type: "file", relPath: "src/index.js" }]
        }
      ],
      selectedFiles: new Set(["file1.js"]),
      expandedPaths: new Set(),
      onSelectionCommand: jest.fn(),
      onToggleSelection: jest.fn(),
      onToggleExpand: jest.fn(),
      onRangeSelect: jest.fn(),
      onOpen: jest.fn()
    };

    component = new FileTreeComponent(props);
    container.appendChild(component.element);
  });

  afterEach(() => {
    if (component) {
      component.detachEventListeners?.();
      component.virtualScroller?.destroy?.();
    }
    container.remove();
    jest.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders file tree structure", () => {
      const treeContent = component.element.querySelector(".file-tree-content");
      expect(treeContent).toBeTruthy();

      const fileNodes = component.element.querySelectorAll(".file-node");
      expect(fileNodes.length).toBe(2);
    });

    it("shows selection controls", () => {
      const buttons = component.element.querySelectorAll(".file-tree-action");
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });

    it("displays file icons", () => {
      const fileIcon = component.element.querySelector(".file-icon");
      expect(fileIcon).toBeTruthy();
    });

    it("marks selected files", () => {
      const checkbox = component.element.querySelector('[data-path="file1.js"] .file-checkbox');
      expect(checkbox.checked).toBe(true);
    });
  });

  describe("user interactions", () => {
    it("handles select-all action", () => {
      const selectAllButton = component.element.querySelector('[data-action="select-all"]');
      selectAllButton.click();
      expect(props.onSelectionCommand).toHaveBeenCalledWith({ type: "select-all" });
    });

    it("toggles file selection", () => {
      const checkbox = component.element.querySelector(".file-checkbox");
      checkbox.click();
      expect(props.onToggleSelection).toHaveBeenCalledWith({ path: "file1.js", selected: checkbox.checked });
    });

    it("toggles directory expansion", () => {
  const directoryNode = component.element.querySelector('[data-path="src/"] .expand-btn');

  expect(directoryNode).toBeTruthy();
  directoryNode.click();
      expect(props.onToggleExpand).toHaveBeenCalledWith({ path: "src/" });
    });

    it("supports keyboard navigation", async () => {
      const content = component.element.querySelector(".file-tree-content");
      const firstNode = component.element.querySelector(".file-node");
      component.focusNode(firstNode);
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));

      await TestUtils.waitFor(() => document.activeElement?.classList?.contains("file-node"), 1500);
      expect(document.activeElement.dataset.path).toBeTruthy();
    });
  });

  describe("updates", () => {
    it("updates when nodes change", () => {
      const newNodes = [{ name: "file2.js", type: "file", relPath: "file2.js" }];
      component.setNodes(newNodes);

      const fileNodes = component.element.querySelectorAll(".file-node");
      expect(fileNodes.length).toBe(1);
      expect(component.element.querySelector('[data-path="file2.js"]')).toBeTruthy();
    });

    it("updates selection state", () => {
      const newSelection = new Set(["src/"]);
      component.setSelection(newSelection);

      const dirCheckbox = component.element.querySelector('[data-path="src/"] .file-checkbox');
      expect(dirCheckbox.checked).toBe(true);
    });
  });

  describe("virtual scrolling", () => {
    it("enables virtualization for large node lists", async () => {
      const largeNodes = Array.from({ length: 500 }, (_, index) => ({
        name: `file${index}.js`,
        type: "file",
        relPath: `file${index}.js`
      }));

      component.setNodes(largeNodes);

      await TestUtils.waitFor(() => component.virtualScroller !== null, 1000);
      expect(component.virtualScroller).toBeTruthy();
      Object.defineProperty(component.virtualScroller.container, "clientHeight", {
        value: 400,
        configurable: true
      });
      component.virtualScroller.renderVisibleItems();
      const rendered = component.virtualScroller.visibleContainer.querySelectorAll(".file-node");
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered.length).toBeLessThanOrEqual(120);
    });
  });

  describe("bulk selection feedback", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("defers directory recalculation and shows status banner for large selections", () => {
      jest.useFakeTimers();
      const largeNodes = Array.from({ length: 1_000 }, (_, index) => ({
        name: `file-${index}.ts`,
        type: "file",
        relPath: `file-${index}.ts`
      }));
      component.setNodes(largeNodes);

      const recalcSpy = jest.spyOn(component, "recalculateDirectorySelection");
      const bulkSelection = new Set(largeNodes.slice(0, 900).map((node) => node.relPath));

      component.setSelection(bulkSelection);

      expect(component.statusBanner?.hasAttribute("hidden")).toBe(false);
      expect(component.statusBanner?.textContent).toContain("Processing");
      expect(recalcSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(49);
      expect(recalcSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(recalcSpy).toHaveBeenCalledTimes(1);
      expect(component.statusBanner?.hasAttribute("hidden")).toBe(true);
      recalcSpy.mockRestore();
    });

    it("surfaces completion feedback when every file is selected", () => {
      jest.useFakeTimers();
      const nodes = [
        { name: "app.ts", type: "file", relPath: "src/app.ts" },
        { name: "util.ts", type: "file", relPath: "src/util.ts" }
      ];
      component.setNodes(nodes);

      component.setSelection(new Set(nodes.map((node) => node.relPath)));

      expect(component.statusBanner?.hasAttribute("hidden")).toBe(false);
      expect(component.statusBanner?.textContent).toContain("All files selected");

      jest.advanceTimersByTime(1_600);
      expect(component.statusBanner?.hasAttribute("hidden")).toBe(true);
    });
  });
});
