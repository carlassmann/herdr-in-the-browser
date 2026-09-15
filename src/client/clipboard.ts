// Herdr copies its own selection with OSC 52, which the terminal renderer
// ignores, so the browser has to make the write itself.
export function writeClipboard(text: string): void {
  navigator.clipboard?.writeText(text).catch((error: unknown) => {
    console.warn("clipboard write from the terminal was refused", error);
  });
}
