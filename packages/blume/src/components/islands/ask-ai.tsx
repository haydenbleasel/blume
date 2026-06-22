import { useState } from "react";
import type { FormEvent } from "react";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

let idCounter = 0;
const nextId = (): number => {
  idCounter += 1;
  return idCounter;
};

const BUTTON_CLASS =
  "inline-flex h-9 cursor-pointer items-center gap-2 rounded-blume border border-border bg-muted px-2.5 text-muted-foreground text-sm hover:border-accent disabled:opacity-50";

const AskAI = () => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const question = input.trim();
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
      const response = await fetch("/api/ask", {
        body: JSON.stringify({
          messages: history.map((m) => ({ content: m.content, role: m.role })),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        let done = false;
        while (!done) {
          // oxlint-disable-next-line no-await-in-loop -- sequential stream reads
          const chunk = await reader.read();
          ({ done } = chunk);
          if (chunk.value) {
            assistant.content += decoder.decode(chunk.value);
            setMessages((current) => [
              ...current.slice(0, -1),
              { ...assistant },
            ]);
          }
        }
      }
    } catch {
      assistant.content = "Sorry, something went wrong.";
      setMessages((current) => [...current.slice(0, -1), { ...assistant }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        className={BUTTON_CLASS}
        onClick={() => setOpen(!open)}
        type="button"
      >
        Ask AI
      </button>
      {open && (
        <div className="absolute top-[calc(100%+0.5rem)] right-0 z-50 flex max-h-[70vh] w-[min(24rem,90vw)] flex-col overflow-hidden rounded-blume border border-border bg-background shadow-xl">
          <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
            {messages.length === 0 && (
              <p className="m-0 text-muted-foreground text-sm">
                Ask a question about the docs.
              </p>
            )}
            {messages.map((message) => (
              <div
                className={`whitespace-pre-wrap rounded-blume px-2.5 py-2 text-sm ${
                  message.role === "user"
                    ? "self-end bg-accent/15"
                    : "self-start bg-muted"
                }`}
                key={message.id}
              >
                {message.content}
              </div>
            ))}
          </div>
          <form
            className="flex gap-2 border-border border-t p-2.5"
            onSubmit={send}
          >
            <input
              aria-label="Ask a question"
              className="flex-1 rounded-blume border border-border bg-transparent px-2.5 py-1.5 text-sm"
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask a question..."
              value={input}
            />
            <button className={BUTTON_CLASS} disabled={busy} type="submit">
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default AskAI;
