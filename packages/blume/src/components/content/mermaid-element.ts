/**
 * Client behaviour for the `<blume-mermaid>` custom element emitted by the
 * Mermaid markdown plugin. Mermaid is lazy-loaded — it needs a DOM and is large,
 * so the dependency only downloads on pages that actually contain a diagram —
 * and each diagram re-renders when the color theme flips so it tracks light/dark.
 *
 * Imported for its side effect (registers the element) from RootLayout's script.
 */

const importMermaid = async () => {
  const mod = await import("mermaid");
  return mod.default;
};

// Memoize the import so a page with several diagrams loads Mermaid once.
let loader: ReturnType<typeof importMermaid> | null = null;
const loadMermaid = () => {
  loader ??= importMermaid();
  return loader;
};

const prefersDark = () => document.documentElement.dataset.theme === "dark";

let counter = 0;

class BlumeMermaid extends HTMLElement {
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

    const render = async () => {
      this.#renderToken += 1;
      const token = this.#renderToken;
      const mermaid = await loadMermaid();
      mermaid.initialize({
        securityLevel: "strict",
        startOnLoad: false,
        theme: prefersDark() ? "dark" : "default",
      });
      try {
        counter += 1;
        const { svg } = await mermaid.render(
          `blume-mermaid-${counter}`,
          source
        );
        // A newer render (rapid theme toggles) superseded this one — dropping
        // the stale result keeps the diagram in the latest theme.
        if (token === this.#renderToken) {
          output.innerHTML = svg;
        }
      } catch {
        output.textContent = "Could not render this diagram.";
      }
      output.removeAttribute("aria-busy");
    };

    render();

    // Re-render on color-theme changes so the diagram tracks light and dark.
    // One observer per connection, disconnected on removal — otherwise every
    // DOM move stacks another observer that renders into detached DOM forever.
    this.#observer?.disconnect();
    this.#observer = new MutationObserver(() => render());
    this.#observer.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
    });
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.#observer = null;
  }
}

if (!customElements.get("blume-mermaid")) {
  customElements.define("blume-mermaid", BlumeMermaid);
}
