/**
 * Client behavior for the `<blume-mermaid>` custom element emitted by the
 * Mermaid markdown plugin. The element module stays small: Pele is imported
 * only when a diagram mounts, and only on pages that actually contain one.
 * Pele renders SVG that reads `--pele-*` CSS variables, so a color-theme flip
 * restyles the diagram without a re-render. A flip that changes the label font
 * is the exception: Pele measured the old font, so the diagram is refreshed.
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
const loadPele = async () => {
  loader ??= importPele();
  try {
    return await loader;
  } catch (error) {
    // A failed download is forgotten, so the next diagram to mount asks
    // again. Client-router navigations keep this module alive, so a kept
    // rejection would fail every diagram until a full page reload. Safari
    // fetches the chunk again on the next import; Chromium caches a failed
    // module fetch for the life of the document, so there the reload is
    // still needed.
    loader = null;
    throw error;
  }
};

const errorMessage = () =>
  document.body.dataset.i18nDiagramError || "Could not render this diagram.";

export class BlumeMermaid extends HTMLElement {
  #diagram: Mounted | null = null;
  #observer: MutationObserver | null = null;
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
    // Whether Pele has drawn this diagram at least once.
    let drawn = false;
    const showError = (error: Error) => {
      if (token !== this.#renderToken) {
        return;
      }
      // Readers get only the message below; the writer needs Pele's parser
      // error (line and snippet) to fix the source. It goes to the console,
      // and `blume dev` also shows it under the message.
      console.error("[blume] Pele could not render a diagram:", error);
      // A re-layout that fails after a good render leaves Pele's last drawing
      // on screen, dimmed under its own one-line error, and Pele restores it
      // on the next layout that works. Replacing that here would strand the
      // message: Pele skips the DOM write when the next layout matches what
      // it last drew, so nothing would put the diagram back.
      if (drawn) {
        return;
      }
      // Pele writes its own error text before calling back; replace it with
      // the localized message the rest of the chrome uses.
      output.replaceChildren();
      output.textContent = errorMessage();
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
              drawn = true;
              output.removeAttribute("aria-busy");
            }
          },
          // No pan-and-zoom controls: a diagram reflows or scales to the
          // column, and one kept at its natural width scrolls in the element.
          zoom: false,
        });

        // A theme can change the body or monospace font, and Pele re-measures
        // only when asked. `refresh()` compares the fonts it measured with the
        // current `--pele-font` and `--pele-font-mono` and does nothing when
        // neither changed, so it is safe to call on every `data-theme` write,
        // including the one the theme script makes after each client-router
        // swap. A re-layout that fails reports through `onError`.
        this.#observer?.disconnect();
        this.#observer = new MutationObserver(() => {
          this.#diagram?.refresh();
        });
        this.#observer.observe(document.documentElement, {
          attributeFilter: ["data-theme"],
        });
      } catch (error) {
        showError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    void mountDiagram();
  }

  disconnectedCallback() {
    this.#renderToken += 1;
    this.#observer?.disconnect();
    this.#observer = null;
    this.#diagram?.destroy();
    this.#diagram = null;
  }
}

if (!customElements.get("blume-mermaid")) {
  customElements.define("blume-mermaid", BlumeMermaid);
}
