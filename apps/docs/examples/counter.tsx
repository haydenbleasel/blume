import { useState } from "react";

const Counter = () => {
  const [count, setCount] = useState(0);

  return (
    <button
      className="rounded-blume border-border bg-background text-foreground hover:bg-muted border px-4 py-2 text-sm font-medium transition-colors"
      onClick={() => setCount((value) => value + 1)}
      type="button"
    >
      Clicked {count} {count === 1 ? "time" : "times"}
    </button>
  );
};

export default Counter;
