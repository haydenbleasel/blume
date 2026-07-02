/**
 * Client behaviour for the OpenAPI request/response panels. `<blume-panel-tabs>`
 * switches the visible `[data-panel="key"]` region when a `[data-panel-tab="key"]`
 * button is clicked, and an optional `[data-panel-copy]` button copies the active
 * panel's text. Vanilla custom element — no framework, in keeping with the core
 * theme.
 */

class BlumePanelTabs extends HTMLElement {
  connectedCallback() {
    const tabs = [
      ...this.querySelectorAll<HTMLButtonElement>("[data-panel-tab]"),
    ];
    const panels = [...this.querySelectorAll<HTMLElement>("[data-panel]")];
    const copy = this.querySelector<HTMLButtonElement>("[data-panel-copy]");

    const activate = (key: string): void => {
      for (const tab of tabs) {
        tab.setAttribute(
          "aria-selected",
          tab.dataset.panelTab === key ? "true" : "false"
        );
      }
      for (const panel of panels) {
        panel.classList.toggle("hidden", panel.dataset.panel !== key);
      }
    };

    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        const key = tab.dataset.panelTab;
        if (key) {
          activate(key);
        }
      });
    }

    if (copy) {
      copy.addEventListener("click", async () => {
        const active = panels.find(
          (panel) => !panel.classList.contains("hidden")
        );
        try {
          await navigator.clipboard.writeText(active?.textContent ?? "");
          copy.dataset.copied = "true";
          setTimeout(() => {
            delete copy.dataset.copied;
          }, 1500);
        } catch {
          // Clipboard unavailable (insecure context); silently ignore.
        }
      });
    }
  }
}

if (!customElements.get("blume-panel-tabs")) {
  customElements.define("blume-panel-tabs", BlumePanelTabs);
}
