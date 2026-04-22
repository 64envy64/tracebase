/**
 * Tiny zero-dependency TTY picker.
 *
 * Used by `tracebase init` to ask the user which agents to configure.
 * Arrow keys move, space toggles, enter confirms. Falls back to a
 * textual numeric picker when the terminal doesn't support raw mode.
 */
import { emitKeypressEvents } from "node:readline";

type Option<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function multiSelect<T extends string>(input: {
  title: string;
  options: Array<Option<T>>;
  initial?: T[];
}): Promise<T[] | null> {
  const { title, options } = input;
  if (options.length === 0) return [];

  if (!isInteractive() || typeof process.stdin.setRawMode !== "function") {
    return null;
  }

  const initialSet = new Set<T>(input.initial ?? []);
  const checked = options.map((opt) => initialSet.has(opt.value));
  let cursor = 0;
  let rendered = 0;
  let done = false;
  let cancelled = false;

  const stdout = process.stdout;
  const stdin = process.stdin;

  const write = (s: string) => stdout.write(s);
  const hideCursor = () => write("\x1b[?25l");
  const showCursor = () => write("\x1b[?25h");
  const clear = () => {
    if (rendered === 0) return;
    for (let i = 0; i < rendered; i++) {
      write("\x1b[2K"); // clear line
      if (i < rendered - 1) write("\x1b[1A"); // move up
    }
    write("\r");
    rendered = 0;
  };

  const render = () => {
    clear();
    const lines: string[] = [];
    lines.push(`\x1b[1m${title}\x1b[0m`);
    lines.push(`\x1b[2m  ↑/↓ move   space toggle   a select all   enter confirm   esc cancel\x1b[0m`);
    options.forEach((opt, i) => {
      const box = checked[i] ? "\x1b[36m[\u2713]\x1b[0m" : "[ ]";
      const point = i === cursor ? "\x1b[36m›\x1b[0m" : " ";
      const hint = opt.hint ? `  \x1b[2m${opt.hint}\x1b[0m` : "";
      const focus = i === cursor ? `\x1b[1m${opt.label}\x1b[0m` : opt.label;
      lines.push(`${point} ${box} ${focus}${hint}`);
    });
    const payload = lines.join("\n");
    write(payload);
    rendered = lines.length;
  };

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  hideCursor();
  render();

  return new Promise<T[] | null>((resolve) => {
    const cleanup = (result: T[] | null) => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      clear();
      showCursor();
      resolve(result);
    };

    const onKey = (
      _str: string,
      key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
    ) => {
      if (done || !key) return;

      if (key.ctrl && key.name === "c") {
        cancelled = true;
        done = true;
        cleanup(null);
        process.exit(130);
        return;
      }

      switch (key.name) {
        case "up":
          cursor = (cursor - 1 + options.length) % options.length;
          render();
          return;
        case "down":
          cursor = (cursor + 1) % options.length;
          render();
          return;
        case "space":
          checked[cursor] = !checked[cursor];
          render();
          return;
        case "a":
          {
            const allOn = checked.every(Boolean);
            for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
          }
          render();
          return;
        case "return":
          done = true;
          cleanup(
            options
              .filter((_, i) => checked[i])
              .map((opt) => opt.value),
          );
          return;
        case "escape":
          cancelled = true;
          done = true;
          cleanup(null);
          return;
      }
    };

    stdin.on("keypress", onKey);

    // Safety net: if the process exits mid-prompt, restore the terminal.
    process.once("exit", () => {
      if (!cancelled) {
        try {
          stdin.setRawMode(false);
          stdin.pause();
          showCursor();
        } catch {
          /* ignore */
        }
      }
    });
  });
}
