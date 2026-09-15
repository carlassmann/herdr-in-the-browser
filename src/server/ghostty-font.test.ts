import { expect, test } from "bun:test";
import { selectFontFile } from "./ghostty-font";

const files = [
  { name: "BerkeleyMono-Regular.otf", path: "/fonts/regular" },
  { name: "BerkeleyMono-Bold.otf", path: "/fonts/bold" },
  { name: "BerkeleyMono-BoldItalic.otf", path: "/fonts/bold-italic" },
];

test("font lookup selects exact variant and refuses a false fallback", () => {
  expect(selectFontFile("Berkeley Mono", "regular", files)).toBe(
    "/fonts/regular",
  );
  expect(selectFontFile("Berkeley Mono", "bold", files)).toBe("/fonts/bold");
  expect(selectFontFile("Berkeley Mono", "bold-italic", files)).toBe(
    "/fonts/bold-italic",
  );
  expect(selectFontFile("Berkeley Mono", "italic", files)).toBeUndefined();
});
