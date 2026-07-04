import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { UIStrings } from "../../core/i18n-ui.ts";
import { joinBase, stripBase } from "./base-path.ts";

interface ChatMessage {
  content: string;
  id: number;
  role: "assistant" | "user";
}

/** A resolved empty-state prompt; `icon` is ready-to-inline SVG (or null). */
interface Suggestion {
  icon: string | null;
  label: string;
}

// English fallback so the island renders even if no dictionary is passed.
const DEFAULT_ASK: UIStrings["ask"] = {
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
};

let idCounter = 0;
const nextId = (): number => {
  idCounter += 1;
  return idCounter;
};

// The endpoint and page path both honor the deployment `base` so grounding works
// under a non-root base path (the server matches base-less document routes).
const ASK_ENDPOINT = joinBase(import.meta.env.BASE_URL, "api/ask");

/** The current route with the deployment base stripped, for page-context lookup. */
const currentPath = (): string =>
  stripBase(import.meta.env.BASE_URL, window.location.pathname);

// GitHub-flavored markdown with soft line breaks, matching how the docs read.
marked.setOptions({ breaks: true, gfm: true });

const renderMarkdown = (content: string): string =>
  DOMPurify.sanitize(marked.parse(content, { async: false }));

// Lucide 24×24 glyphs, inlined so the island carries no icon runtime.
const ICON = {
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  clear:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  close: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

const Glyph = ({ path, size = 16 }: { path: string; size?: number }) => (
  <svg
    aria-hidden="true"
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
  strings,
  suggestions = EMPTY_SUGGESTIONS,
}: {
  strings?: UIStrings["ask"];
  suggestions?: Suggestion[];
}) => {
  const t = strings ?? DEFAULT_ASK;
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Portal target (document.body) only exists after mount; guards SSR.
  useEffect(() => setMounted(true), []);

  // The search modal forwards its query so "Ask AI: <query>" carries straight in.
  useEffect(() => {
    const handler = (event: Event) => {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query;
      if (query) {
        setInput(query);
      }
      setOpen(true);
    };
    window.addEventListener("blume:open-ask-ai", handler);
    return () => window.removeEventListener("blume:open-ask-ai", handler);
  }, []);

  // ⌘I / Ctrl+I toggles the panel; Escape closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Drive the desktop content push from a body attribute (see AskAI.astro CSS).
  useEffect(() => {
    if (open) {
      document.body.dataset.blumeAsk = "open";
      inputRef.current?.focus();
    } else {
      delete document.body.dataset.blumeAsk;
    }
    return () => {
      delete document.body.dataset.blumeAsk;
    };
  }, [open]);

  // Keep the newest message in view as it streams in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const runQuestion = async (raw: string) => {
    const question = raw.trim();
    if (!question || busy) {
      return;
    }

    const userMessage: ChatMessage = {
      content: question,
      id: nextId(),
      role: "user",
    };
    const history = [...messages, userMessage];
    const assistant: ChatMessage = {
      content: "",
      id: nextId(),
      role: "assistant",
    };
    setMessages([...history, assistant]);
    setInput("");
    setBusy(true);

    try {
      const response = await fetch(ASK_ENDPOINT, {
        body: JSON.stringify({
          messages: history.map((m) => ({ content: m.content, role: m.role })),
          page: { path: currentPath() },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      // A 4xx/5xx still has a body; without this guard its error text would be
      // decoded and shown as the assistant's answer instead of the error notice.
      if (!(response.ok && response.body)) {
        throw new Error(`Ask AI request failed (${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      while (!done) {
        // oxlint-disable-next-line no-await-in-loop -- sequential stream reads
        const chunk = await reader.read();
        ({ done } = chunk);
        if (chunk.value) {
          assistant.content += decoder.decode(chunk.value);
          setMessages((current) => [...current.slice(0, -1), { ...assistant }]);
        }
      }
    } catch {
      assistant.content = t.error;
      setMessages((current) => [...current.slice(0, -1), { ...assistant }]);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void runQuestion(input);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void runQuestion(input);
    }
  };

  const copyConversation = () => {
    const text = messages
      .map((m) => `${m.role === "user" ? "You" : "AI"}: ${m.content}`)
      .join("\n\n");
    void navigator.clipboard?.writeText(text);
  };

  const hasMessages = messages.length > 0;

  const panel = (
    <aside
      aria-hidden={open ? undefined : "true"}
      aria-label={t.title}
      className={`fixed inset-y-0 end-0 z-[60] flex w-[var(--blume-ask-width)] flex-col border-border border-s bg-background shadow-2xl transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "translate-x-full rtl:-translate-x-full"
      }`}
    >
      <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-border border-b px-4">
        <span className="font-semibold text-foreground">{t.title}</span>
        <div className="flex items-center gap-0.5">
          <button
            aria-label={t.copy}
            className={ICON_BUTTON_CLASS}
            disabled={!hasMessages}
            onClick={copyConversation}
            title={t.copy}
            type="button"
          >
            <Glyph path={ICON.copy} />
          </button>
          <button
            aria-label={t.clear}
            className={ICON_BUTTON_CLASS}
            disabled={!hasMessages}
            onClick={() => setMessages([])}
            title={t.clear}
            type="button"
          >
            <Glyph path={ICON.clear} />
          </button>
          <button
            aria-label={t.close}
            className={ICON_BUTTON_CLASS}
            onClick={() => setOpen(false)}
            title={t.close}
            type="button"
          >
            <Glyph path={ICON.close} size={18} />
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-y-auto" ref={scrollRef}>
        {hasMessages ? (
          <div className="flex flex-col gap-4 p-4">
            {messages.map((message) =>
              message.role === "user" ? (
                <div
                  className="max-w-[85%] self-end whitespace-pre-wrap rounded-blume bg-muted px-3 py-2 text-foreground text-sm"
                  key={message.id}
                >
                  {message.content}
                </div>
              ) : (
                <div className={ANSWER_CLASS} key={message.id}>
                  {message.content ? (
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
                    <div
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(message.content),
                      }}
                    />
                  ) : (
                    <span className="animate-pulse text-muted-foreground">
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
              <p className="px-2 text-muted-foreground text-sm">{t.empty}</p>
            )}
            {suggestions.map((suggestion) => (
              <button
                className="flex cursor-pointer items-center gap-2.5 rounded-blume px-2 py-2 text-start text-foreground text-sm transition-colors hover:bg-muted"
                key={suggestion.label}
                onClick={() => runQuestion(suggestion.label)}
                type="button"
              >
                {suggestion.icon && (
                  <span
                    className="shrink-0 text-muted-foreground [&_svg]:h-[18px] [&_svg]:w-[18px]"
                    dangerouslySetInnerHTML={{ __html: suggestion.icon }}
                  />
                )}
                <span>{suggestion.label}</span>
              </button>
            ))}
            <p className="mt-3 flex items-center gap-1.5 px-2 text-muted-foreground text-sm">
              {t.tip}
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs">
                ⌘
              </kbd>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs">
                I
              </kbd>
            </p>
          </div>
        )}
      </div>

      <form
        className="relative shrink-0 border-border border-t"
        onSubmit={onSubmit}
      >
        <textarea
          aria-label={t.label}
          className="max-h-48 min-h-[5rem] w-full resize-none bg-transparent px-4 py-3.5 pe-14 text-foreground text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={t.placeholder}
          ref={inputRef}
          rows={3}
          value={input}
        />
        <button
          aria-label={t.send}
          className="absolute end-3 bottom-3 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-blume bg-foreground text-background transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy || input.trim().length === 0}
          type="submit"
        >
          <Glyph path={ICON.arrowUp} />
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
        title={t.title}
        type="button"
      >
        <Glyph path={ICON.chat} size={18} />
      </button>
      {mounted && createPortal(panel, document.body)}
    </>
  );
};

export default AskAI;
