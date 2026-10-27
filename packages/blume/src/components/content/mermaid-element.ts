/**
 * Client behavior for the `<blume-mermaid>` custom element emitted by the
 * Mermaid markdown plugin. The element module stays small: Pele is imported
 * only when a diagram mounts, and only on pages that actually contain one.
 * Pele renders SVG that reads `--pele-*` CSS variables, so a color-theme flip
 * restyles the diagram without a re-render.
 *
 * Imported for its side effect (registers the element) from RootLayout's script.
 */

import type { Mounted } from "pele";

// Memoize the import so a page with several diagrams loads Pele once. Keeping
// the import dynamic is what leaves Pele out of pages with no diagram: this
// module is imported on every page of a site that has one, so a static import
// here would load the renderer everywhere.
const importPele = () => import("pele");
let loader: ReturnType<typeof importPele> | null = null;
const loadPele = () => {
  loader ??= importPele();
  return loader;
};

const errorMessage = () =>
  document.body.dataset.i18nDiagramError || "Could not render this diagram.";

export class BlumeMermaid extends HTMLElement {
  #diagram: Mounted | null = null;
  #renderToken = 0;

  connectedCallback() {
    const source = this.dataset.source ?? "";
    if (!source.trim()) {
      return;
    }

    const output = document.createElement("div");
    output.setAttribute("aria-busy", "true");
    this.replaceChildren(output);

    // A reconnect or a newer mount invalidates a pending import or render.
    this.#renderToken += 1;
    const token = this.#renderToken;
    const showError = (error: Error) => {
      if (token !== this.#renderToken) {
        return;
      }
      // Pele writes its own error text before calling back; replace it with
      // the localized message the rest of the chrome uses.
      output.replaceChildren();
      output.textContent = errorMessage();
      // Readers get only the message above; the writer needs Pele's parser
      // error (line and snippet) to fix the source. It goes to the console,
      // and `blume dev` also shows it under the message.
      console.error("[blume] Pele could not render a diagram:", error);
      if (import.meta.env.DEV) {
        const detail = document.createElement("pre");
        detail.className = "mt-2 overflow-x-auto text-muted-foreground text-xs";
        detail.textContent = String(error);
        output.append(detail);
      }
      output.removeAttribute("aria-busy");
    };

    const mountDiagram = async () => {
      try {
        const { mount } = await loadPele();
        // The element may have been removed or remounted while Pele loaded.
        if (token !== this.#renderToken || !this.isConnected) {
          return;
        }
        this.#diagram?.destroy();
        // `mount` reads `--pele-font` from the computed style, measures the
        // labels, lays the diagram out for the column (wide flowcharts reflow
        // rather than shrink), and redraws when the container resizes or a web
        // font loads.
        this.#diagram = mount(output, source, {
          onError: (error) =>
            showError(
              error instanceof Error ? error : new Error(String(error))
            ),
          onRender: () => {
            if (token === this.#renderToken) {
              output.removeAttribute("aria-busy");
            }
          },
          // Pele's zoom chrome speaks English only; a wide diagram reflows instead.
          zoom: false,
        });
      } catch (error) {
        showError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    void mountDiagram();
  }

  disconnectedCallback() {
    this.#renderToken += 1;
    this.#diagram?.destroy();
    this.#diagram = null;
  }
}

if (!customElements.get("blume-mermaid")) {
  customElements.define("blume-mermaid", BlumeMermaid);
}
