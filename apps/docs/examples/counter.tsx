import { useState } from "react";

const Counter = () => {
  const [count, setCount] = useState(0);

  return (
    <button
      className="rounded-blume border border-border bg-background px-4 py-2 font-medium text-foreground text-sm transition-colors hover:bg-muted"
      onClick={() => setCount((value) => value + 1)}
      type="button"
    >
      Clicked {count} {count === 1 ? "time" : "times"}
    </button>
  );
};

export default Counter;
