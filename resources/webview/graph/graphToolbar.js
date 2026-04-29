(function () {
  window.initCodeIngestToolbar = function initCodeIngestToolbar(config) {
    const layoutButtons = document.querySelectorAll("#layoutToggle button");
    const modeButtons = document.querySelectorAll("#modeToggle button");
    const searchBox = document.getElementById("searchBox");
    const focusButton = document.getElementById("focusButton");
    const fitButton = document.getElementById("fitButton");
    const exportButton = document.getElementById("exportButton");
    const statsBadge = document.getElementById("statsBadge");

    layoutButtons.forEach((button) => {
      button.addEventListener("click", () => {
        layoutButtons.forEach((entry) => entry.classList.remove("active"));
        button.classList.add("active");
        config.onLayoutChange(button.dataset.layout);
      });
    });

    modeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        modeButtons.forEach((entry) => entry.classList.remove("active"));
        button.classList.add("active");
        config.onModeChange(button.dataset.mode);
      });
    });

    searchBox.addEventListener("input", () => {
      config.onSearch(searchBox.value);
    });

    focusButton.addEventListener("click", () => config.onFocus());
    fitButton.addEventListener("click", () => config.onFit());
    exportButton.addEventListener("click", () => config.onExport());

    return {
      setStats(text) {
        statsBadge.textContent = text;
      },
      setLayout(value) {
        layoutButtons.forEach((button) => {
          button.classList.toggle("active", button.dataset.layout === value);
        });
      },
      setMode(value) {
        modeButtons.forEach((button) => {
          button.classList.toggle("active", button.dataset.mode === value);
        });
      },
      setSearch(value) {
        searchBox.value = value || "";
      }
    };
  };
})();
