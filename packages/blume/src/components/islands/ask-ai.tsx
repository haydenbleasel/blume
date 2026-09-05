import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { UIStrings } from "../../core/i18n-ui.ts";
import { copyText } from "../copy-feedback.ts";
import { joinBase, prefixBase } from "./base-path.ts";
import { useAskAI } from "./hooks.ts";

/** A resolved empty-state prompt; `icon` is ready-to-inline SVG (or null). */
interface Suggestion {
  icon: string | null;
  label: string;
}

/**
 * The panel's chrome glyphs, resolved server-side in `AskAI.astro` and passed in
 * as ready-to-inline Lucide bodies so this client island ships no icon data.
 */
interface AskIcons {
  arrowUp: string;
  chat: string;
  clear: string;
  close: string;
  copy: string;
}

// Empty bodies so the island still renders (iconless) if instantiated without
// the Astro wrapper that resolves the real Lucide glyphs.
const EMPTY_ICONS: AskIcons = {
  arrowUp: "",
  chat: "",
  clear: "",
  close: "",
  copy: "",
};

// English fallback so the island renders even if no dictionary is passed.
const DEFAULT_ASK: UIStrings["ask"] = {
  ai: "AI",
  clear: "Clear conversation",
  close: "Close",
  copy: "Copy conversation",
  empty: "Ask a question about the docs.",
  error: "Sorry, something went wrong.",
  label: "Ask a question",
  placeholder: "Ask a question…",
  send: "Send",
  tip: "Tip: You can open and close chat with",
  title: "Ask AI",
  you: "You",
};

// The endpoint honors the deployment `base` so grounding works under a
// non-root base path (the server matches base-less document routes).
const DEFAULT_ASK_ENDPOINT = joinBase(import.meta.env.BASE_URL, "api/ask");

// GitHub-flavored markdown with soft line breaks, matching how the docs read.
// A dedicated instance, not the shared `marked` singleton: `setOptions`/`use`
// on the singleton would leak `breaks` and the link rewriter into any other
// consumer of `marked` on the page (user components included).
const markdown = new Marked({
  breaks: true,
  gfm: true,
  // The model cites pages as base-less logical routes (`[Title](/route)`); rewrite
  // link targets to served URLs so citations resolve under `deployment.base`.
  // `prefixBase` leaves external URLs and fragments untouched and is idempotent.
  walkTokens: (token) => {
    if (token.type === "link") {
      token.href = prefixBase(import.meta.env.BASE_URL, token.href);
    }
  },
});

const renderMarkdown = (content: string): string =>
  DOMPurify.sanitize(markdown.parse(content, { async: false }));

const Glyph = ({ path, size = 16 }: { path: string; size?: number }) => (
  <svg
    aria-hidden="true"
    // `path` is a trusted, server-resolved Lucide glyph body (inline SVG),
    // not user content; it must be injected as markup to render the icon.
    // oxlint-disable-next-line react/no-danger -- trusted server-resolved inline SVG glyph
    dangerouslySetInnerHTML={{ __html: path }}
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
    width={size}
    xmlns="http://www.w3.org/2000/svg"
  />
);

// Stable empty default so an unset `suggestions` prop doesn't re-render.
const EMPTY_SUGGESTIONS: Suggestion[] = [];

// The toggle shortcut accepts both ⌘I and Ctrl+I; show the right modifier per
// platform (same detection Search.astro uses for its ⌘K hint). Guarded via
// `globalThis` so the island still server-renders where `navigator` doesn't
// exist; the hint itself only renders client-side, inside the portaled panel.
const IS_APPLE =
  globalThis.navigator !== undefined &&
  /mac|iphone|ipad|ipod/iu.test(globalThis.navigator.platform);

// Duck-typed (`closest` presence) rather than `instanceof Element`, which
// needs a DOM global the test environment doesn't provide.
const isElementLike = (target: EventTarget | null): target is Element => {
  // SAFETY: the cast only names the probed surface; `closest` is verified to
  // exist before the caller uses it.
  const candidate = target as Partial<Element> | null;
  return typeof candidate?.closest === "function";
};

// Ghost icon button, matching the header's theme toggle and repo link.
const TRIGGER_CLASS =
  "inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
const ICON_BUTTON_CLASS =
  "inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-blume text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

// The assistant answer: standard prose, but citation links (every `[Title](/route)`
// the model emits) render as small neutral pills so they read as sources instead
// of inline text links. `no-underline`/color use `!` to beat the theme's unlayered
// `.prose a` rule; `leading-none` drops the inherited prose line-height so the
// pill hugs its label.
const ANSWER_CLASS =
  "prose prose-sm max-w-none text-foreground [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1 [&_a]:rounded-full [&_a]:bg-muted [&_a]:px-2 [&_a]:py-1 [&_a]:align-middle [&_a]:font-medium [&_a]:text-[0.7rem] [&_a]:leading-none [&_a]:text-muted-foreground! [&_a]:no-underline! [&_a:hover]:text-foreground!";

const AskAI = ({
  endpoint = DEFAULT_ASK_ENDPOINT,
  icons = EMPTY_ICONS,
  strings,
  suggestions = EMPTY_SUGGESTIONS,
}: {
  endpoint?: string;
  icons?: AskIcons;
  strings?: UIStrings["ask"];
  suggestions?: Suggestion[];
}) => {
  // Merge per key (not `strings ?? …`) so a dictionary from a stale snapshot
  // that predates newer keys still resolves every label to its English default.
  const t = { ...DEFAULT_ASK, ...strings };
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  // The streaming client — request shaping, optimistic assistant bubble,
  // stale-stream/abort guards, error-body handling — is the public useAskAI
  // hook, so the built-in panel and custom UIs share one implementation.
  const {
    ask,
    loading: busy,
    messages,
    reset,
  } = useAskAI({ endpoint, errorMessage: t.error });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The portaled panel root, excluded from the overlay-mode inert sweep.
  const panelRef = useRef<HTMLElement>(null);
  // Where focus came from when the panel opened, restored on close.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Where the panel portals to — the CURRENT document.body, held as state.
  // Null until mount (guards SSR), then refreshed on every client-router swap:
  // the island rides across navigations via transition:persist, but each swap
  // installs a NEW <body>, discarding the portaled panel with the old one and
  // resetting the `data-blume-ask` push attribute to the incoming page's
  // server-rendered set. Reading document.body inline in render would NOT
  // recover from that — it isn't a reactive value, so the memoized portal
  // keeps its stale (detached) container. State identity is what re-anchors
  // the portal and re-runs the body-scoped effects below.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // The initial null→body flip is deliberate (there is no body during SSR);
    // it is the same one-time post-mount cascade the old `mounted` flag had.
    // oxlint-disable-next-line react/react-compiler, react/set-state-in-effect -- deliberate post-mount portal-target initialization
    setPortalTarget(document.body);
    const onSwap = () => setPortalTarget(document.body);
    document.addEventListener("astro:after-swap", onSwap);
    return () => document.removeEventListener("astro:after-swap", onSwap);
  }, []);

  // The search modal forwards its query so "Ask AI: <query>" carries straight in.
  useEffect(() => {
    const handler = (event: Event) => {
      // SAFETY: `blume:open-ask-ai` is only ever dispatched as a CustomEvent
      // whose optional detail carries the search query.
      const query = (event as CustomEvent<{ query?: string }>).detail?.query;
      if (query) {
        setInput(query);
      }
      setOpen(true);
    };
    window.addEventListener("blume:open-ask-ai", handler);
    return () => window.removeEventListener("blume:open-ask-ai", handler);
  }, []);

  // ⌘I / Ctrl+I toggles the panel; Escape closes it. Shift/Alt chords are
  // left alone — Ctrl+Shift+I is the browser's DevTools shortcut, and
  // capturing it would flap the panel open alongside them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "i"
      ) {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape" && open) {
        // An Escape aimed at a modal surface stacked on top (the search
        // dialog traps focus inside itself) dismisses that surface only —
        // this window listener still fires for it, and closing the panel
        // underneath too would eat the user's conversation view.
        if (isElementLike(event.target) && event.target.closest("dialog")) {
          return;
        }
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Drive the desktop content push from a body attribute (see AskAI.astro CSS).
  useEffect(() => {
    if (open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      document.body.dataset.blumeAsk = "open";
      inputRef.current?.focus();
    } else {
      delete document.body.dataset.blumeAsk;
      // Return focus to the element that opened the panel (or the trigger when
      // it's gone), so closing doesn't strand keyboard focus in an inert tree.
      // `returnFocusRef` is only set on open, so initial mount is a no-op.
      if (returnFocusRef.current) {
        const target = returnFocusRef.current.isConnected
          ? returnFocusRef.current
          : triggerRef.current;
        returnFocusRef.current = null;
        target?.focus();
      }
    }
    return () => {
      delete document.body.dataset.blumeAsk;
    };
  }, [open]);

  // Re-stamp the push attribute after a swap while the panel is open — the new
  // body arrives without it. Deliberately separate from the effect above: a
  // navigation must not re-run the focus handling and yank focus out of the
  // page the reader just moved to.
  useEffect(() => {
    // document.body (not portalTarget) so the compiler doesn't flag a state
    // mutation; by the time this runs for a swap, they are the same element.
    if (open && portalTarget) {
      document.body.dataset.blumeAsk = "open";
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above
  }, [open, portalTarget]);

  // Below the desktop dock breakpoint the open panel is a full-width overlay,
  // so Tab must not escape into the page it covers: every other child of
  // <body> (the panel portals to body) turns inert until close. The desktop
  // dock keeps the page interactive on purpose — it's a non-modal side panel,
  // so no sweep runs at ≥1024px. Elements that were already inert are left
  // alone so closing doesn't accidentally re-enable them.
  useEffect(() => {
    if (!open) {
      return;
    }
    const media = window.matchMedia("(min-width: 1024px)");
    let inerted: Element[] = [];
    const release = () => {
      for (const el of inerted) {
        el.removeAttribute("inert");
      }
      inerted = [];
    };
    const apply = () => {
      release();
      if (media.matches) {
        return;
      }
      inerted = [...document.body.children].filter(
        (el) => el !== panelRef.current && !el.hasAttribute("inert")
      );
      for (const el of inerted) {
        el.setAttribute("inert", "");
      }
    };
    apply();
    // The sweep snapshots body's children at open time, but overlays keep
    // arriving afterwards — medium-zoom's backdrop, a mermaid render, another
    // island's portal all append to <body> — and an unswept latecomer is a
    // tab stop hiding behind the overlay. Fold additions into the sweep for
    // as long as it is active.
    const observer = new MutationObserver((records) => {
      if (media.matches) {
        return;
      }
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node !== panelRef.current &&
            !node.hasAttribute("inert")
          ) {
            node.setAttribute("inert", "");
            inerted.push(node);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true });
    media.addEventListener("change", apply);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", apply);
      release();
    };
    // portalTarget: each swap installs a new <body>, so the sweep and its
    // observer must re-run against the new children (the old ones are
    // detached).
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above
  }, [open, portalTarget]);

  // Keep the newest message in view as it streams in — and after a swap, when
  // the re-portaled panel's scroll container is reborn at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- both deps are triggers, not values read here: re-run per streamed message and per re-portaled panel
  }, [messages, portalTarget]);

  const runQuestion = (raw: string) => {
    const question = raw.trim();
    if (!question || busy) {
      return;
    }
    void ask(question);
    setInput("");
  };

  const clearConversation = () => {
    reset();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    runQuestion(input);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // `isComposing` guards IME input: Enter confirming a CJK conversion must
    // commit the text, not submit the question.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      runQuestion(input);
    }
  };

  const copyConversation = () => {
    const text = messages
      .map((m) => `${m.role === "user" ? t.you : t.ai}: ${m.content}`)
      .join("\n\n");
    void copyText(text);
  };

  const hasMessages = messages.length > 0;

  const panel = (
    <aside
      aria-hidden={open ? undefined : "true"}
      aria-label={t.title}
      ref={panelRef}
      // The closed panel is only translated off-screen; `inert` drops its
      // buttons/textarea from the tab order and the accessibility tree.
      inert={!open}
      className={`border-border bg-background fixed inset-y-0 end-0 z-[60] flex w-[var(--blume-ask-width)] flex-col border-s shadow-2xl transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "translate-x-full rtl:-translate-x-full"
      }`}
    >
      <header className="border-border flex h-16 shrink-0 items-center justify-between gap-2 border-b px-4">
        <span className="text-foreground font-semibold">{t.title}</span>
        <div className="flex items-center gap-0.5">
          <button
            aria-label={t.copy}
            className={ICON_BUTTON_CLASS}
            disabled={!hasMessages}
            onClick={copyConversation}
            type="button"
          >
            <Glyph path={icons.copy} />
          </button>
          <button
            aria-label={t.clear}
            className={ICON_BUTTON_CLASS}
            disabled={!hasMessages}
            onClick={clearConversation}
            type="button"
          >
            <Glyph path={icons.clear} />
          </button>
          <button
            aria-label={t.close}
            className={ICON_BUTTON_CLASS}
            onClick={() => setOpen(false)}
            type="button"
          >
            <Glyph path={icons.close} size={18} />
          </button>
        </div>
      </header>

      <div
        className="scrollbar-thumb-border flex flex-1 scrollbar-thin scrollbar-track-transparent flex-col overflow-y-auto"
        ref={scrollRef}
      >
        {hasMessages ? (
          <div className="flex flex-col gap-4 p-4">
            {/* Index keys are safe here: the list only appends, mutates its
                last entry while streaming, or clears wholesale on reset. */}
            {messages.map((message, index) =>
              message.role === "user" ? (
                <div
                  className="rounded-blume bg-muted text-foreground max-w-[85%] self-end px-3 py-2 text-sm whitespace-pre-wrap"
                  // oxlint-disable-next-line react/no-array-index-key -- append-only list, see above
                  key={index}
                >
                  {message.content}
                </div>
              ) : (
                // oxlint-disable-next-line react/no-array-index-key -- append-only list, see above
                <div className={ANSWER_CLASS} key={index}>
                  {message.content ? (
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
                    <div
                      // renderMarkdown runs marked output through DOMPurify.sanitize.
                      // oxlint-disable-next-line react/no-danger -- sanitized (DOMPurify) rendered-markdown output
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(message.content),
                      }}
                    />
                  ) : (
                    <span className="text-muted-foreground animate-pulse">
                      …
                    </span>
                  )}
                </div>
              )
            )}
          </div>
        ) : (
          <div className="mt-auto flex flex-col gap-0.5 p-4">
            {suggestions.length === 0 && (
              <p className="text-muted-foreground px-2 text-sm">{t.empty}</p>
            )}
            {suggestions.map((suggestion) => (
              <button
                className="rounded-blume text-foreground hover:bg-muted flex cursor-pointer items-center gap-2.5 px-2 py-2 text-start text-sm transition-colors"
                key={suggestion.label}
                onClick={() => runQuestion(suggestion.label)}
                type="button"
              >
                {suggestion.icon && (
                  <span
                    className="text-muted-foreground shrink-0 [&_svg]:h-[18px] [&_svg]:w-[18px]"
                    // oxlint-disable-next-line react/no-danger -- trusted server-resolved inline SVG glyph
                    dangerouslySetInnerHTML={{ __html: suggestion.icon }}
                  />
                )}
                <span>{suggestion.label}</span>
              </button>
            ))}
            <p className="text-muted-foreground mt-3 flex items-center gap-1.5 px-2 text-sm">
              {t.tip}
              <kbd className="border-border bg-muted rounded border px-1.5 py-0.5 font-sans text-xs">
                {IS_APPLE ? "⌘" : "Ctrl"}
              </kbd>
              <kbd className="border-border bg-muted rounded border px-1.5 py-0.5 font-sans text-xs">
                I
              </kbd>
            </p>
          </div>
        )}
      </div>

      <form
        className="border-border relative shrink-0 border-t"
        onSubmit={onSubmit}
      >
        <textarea
          aria-label={t.label}
          className="text-foreground placeholder:text-muted-foreground max-h-48 min-h-[5rem] w-full resize-none bg-transparent px-4 py-3.5 pe-14 text-sm outline-none pointer-coarse:text-base"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={t.placeholder}
          ref={inputRef}
          rows={3}
          value={input}
        />
        <button
          aria-label={t.send}
          className="rounded-blume bg-foreground text-background absolute end-3 bottom-3 inline-flex h-8 w-8 cursor-pointer items-center justify-center transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy || input.trim().length === 0}
          type="submit"
        >
          <Glyph path={icons.arrowUp} />
        </button>
      </form>
    </aside>
  );

  return (
    <>
      <button
        aria-expanded={open}
        aria-label={t.title}
        className={TRIGGER_CLASS}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <Glyph path={icons.chat} size={18} />
      </button>
      {portalTarget && createPortal(panel, portalTarget)}
    </>
  );
};

export default AskAI;
