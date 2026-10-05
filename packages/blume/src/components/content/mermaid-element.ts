/**
 * Client behavior for the `<blume-mermaid>` custom element emitted by the
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

// Exported so this file is a module, not a script: `blume:features` lazy-loads
// it with `import()`, and `astro check` rejects a dynamic import of a file with
// no import or export of its own (ts(2306)) on every site with a diagram.
export class BlumeMermaid extends HTMLElement {
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
        // Mermaid 12 defaults to the bundled ELK layout and the "neo" look,
        // which re-lays out and restyles every existing diagram and pulls a
        // ~1.4 MB ELK chunk onto any page with a flowchart. Pin the previous
        // defaults so diagrams keep rendering as authored; a diagram opts
        // into ELK or neo through its own front matter (`config: { layout:
        // elk }`), which outranks these initialize() values.
        layout: "dagre",
        look: "classic",
        securityLevel: "strict",
        startOnLoad: false,
        // Without this, a diagram that fails to parse leaves Mermaid's own
        // "Syntax error in text" graphic appended to <body>, below the page.
        suppressErrorRendering: true,
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
          // Mermaid's own render output is SVG markup; it must be injected as
          // HTML, not text. securityLevel "strict" (see initialize) sanitizes it.
          // oxlint-disable-next-line github/no-inner-html -- Mermaid-generated SVG must be injected as HTML
          output.innerHTML = svg;
        }
      } catch (error) {
        // Localized message stamped on <body> by RootLayout's markup (the
        // data-attribute channel); English fallback when the attribute is
        // missing (a stale snapshot or a custom layout).
        output.textContent =
          document.body.dataset.i18nDiagramError ||
          "Could not render this diagram.";
        // Readers get only the message above; the writer needs Mermaid's
        // parser error (line and expected token) to fix the source. It goes
        // to the console, and `blume dev` also shows it under the message.
        console.error("[blume] Mermaid could not render a diagram:", error);
        if (import.meta.env.DEV) {
          const detail = document.createElement("pre");
          detail.className =
            "mt-2 overflow-x-auto text-muted-foreground text-xs";
          detail.textContent = String(error);
          output.append(detail);
        }
      }
      output.removeAttribute("aria-busy");
    };

    render();

    // Re-render on color-theme changes so the diagram tracks light and dark.
    // One observer per connection, disconnected on removal — otherwise every
    // DOM move stacks another observer that renders into detached DOM forever.
    // The theme script rewrites `data-theme` after every client-router swap,
    // usually to the value it already had, so only a real flip re-renders.
    let dark = prefersDark();
    this.#observer?.disconnect();
    this.#observer = new MutationObserver(() => {
      if (prefersDark() !== dark) {
        dark = prefersDark();
        render();
      }
    });
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
