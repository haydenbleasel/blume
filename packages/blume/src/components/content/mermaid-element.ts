/**
 * Client behavior for the `<blume-mermaid>` custom element emitted by the
 * Mermaid markdown plugin. Pele is lazy-loaded — it needs a DOM and is large,
 * so the dependency only downloads on pages that actually contain a diagram —
 * and it renders SVG that reads `--pele-*` CSS variables, so a color-theme flip
 * restyles the diagram without a re-render.
 *
 * Imported for its side effect (registers the element) from RootLayout's script.
 */

import { mount } from "pele";
import type { Mounted } from "pele";

const errorMessage = () =>
  document.body.dataset.i18nDiagramError || "Could not render this diagram.";

export class BlumeMermaid extends HTMLElement {
  #diagram: Mounted | null = null;

  connectedCallback() {
    const source = this.dataset.source ?? "";
    if (!source.trim()) {
      return;
    }

    const output = document.createElement("div");
    output.setAttribute("aria-busy", "true");
    this.replaceChildren(output);

    // A moved element reconnects, so land exactly one live diagram. `mount`
    // reads `--pele-font` from the computed style, measures the labels, lays
    // the diagram out for the column (wide flowcharts reflow rather than
    // shrink), and redraws when the container resizes or a web font loads.
    this.#diagram?.destroy();
    this.#diagram = mount(output, source, {
      onError: (error) => {
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
          detail.className =
            "mt-2 overflow-x-auto text-muted-foreground text-xs";
          detail.textContent = String(error);
          output.append(detail);
        }
        output.removeAttribute("aria-busy");
      },
      onRender: () => output.removeAttribute("aria-busy"),
      // Pele's zoom chrome speaks English only; a wide diagram reflows instead.
      zoom: false,
    });
  }

  disconnectedCallback() {
    this.#diagram?.destroy();
    this.#diagram = null;
  }
}

if (!customElements.get("blume-mermaid")) {
  customElements.define("blume-mermaid", BlumeMermaid);
}
