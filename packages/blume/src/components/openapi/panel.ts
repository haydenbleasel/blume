/**
 * Client behavior for the OpenAPI request/response panels. `<blume-panel-tabs>`
 * switches the visible `[data-panel="key"]` region when a `[data-panel-tab="key"]`
 * button is clicked, and an optional `[data-panel-copy]` button copies the active
 * panel's text. Vanilla custom element — no framework, in keeping with the core
 * theme.
 */

import { copyText, createCopyFlash } from "../copy-feedback.ts";

class BlumePanelTabs extends HTMLElement {
  connectedCallback() {
    const tabs = [
      ...this.querySelectorAll<HTMLButtonElement>("[data-panel-tab]"),
    ];
    const panels = [...this.querySelectorAll<HTMLElement>("[data-panel]")];
    const copy = this.querySelector<HTMLButtonElement>("[data-panel-copy]");

    const activate = (key: string): void => {
      for (const tab of tabs) {
        const selected = tab.dataset.panelTab === key;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        // Roving tabindex: Tab reaches the selected tab only, the arrow keys
        // move between the rest.
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of panels) {
        panel.classList.toggle("hidden", panel.dataset.panel !== key);
      }
    };

    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener("click", () => {
        const key = tab.dataset.panelTab;
        if (key) {
          activate(key);
        }
      });
      // The WAI-ARIA tabs keyboard pattern, matching `<Tabs>`: arrows move and
      // wrap, Home and End jump to the ends, and focus follows selection.
      tab.addEventListener("keydown", (event) => {
        const last = tabs.length - 1;
        // The strip runs right to left under dir="rtl", so the arrows swap.
        const rtl = getComputedStyle(this).direction === "rtl";
        let next: number | undefined;
        if (event.key === (rtl ? "ArrowLeft" : "ArrowRight")) {
          next = index === last ? 0 : index + 1;
        } else if (event.key === (rtl ? "ArrowRight" : "ArrowLeft")) {
          next = index === 0 ? last : index - 1;
        } else if (event.key === "Home") {
          next = 0;
        } else if (event.key === "End") {
          next = last;
        }
        const target = next === undefined ? undefined : tabs[next];
        const key = target?.dataset.panelTab;
        if (!(target && key)) {
          return;
        }
        event.preventDefault();
        activate(key);
        target.focus();
      });
    }

    if (copy) {
      const flash = createCopyFlash((copied) => {
        if (copied) {
          copy.dataset.copied = "true";
        } else {
          delete copy.dataset.copied;
        }
      }, "Copied");
      copy.addEventListener("click", async () => {
        const active = panels.find(
          (panel) => !panel.classList.contains("hidden")
        );
        if (await copyText(active?.textContent ?? "")) {
          flash();
        }
      });
    }
  }
}

if (!customElements.get("blume-panel-tabs")) {
  customElements.define("blume-panel-tabs", BlumePanelTabs);
}
