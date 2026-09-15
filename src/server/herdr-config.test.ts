import { describe, expect, test } from "bun:test";
import { forwardNotificationsToTerminal } from "./herdr";

describe("forwardNotificationsToTerminal", () => {
  test("adds the sections an empty config lacks", () => {
    expect(forwardNotificationsToTerminal("")).toBe(
      '\n[ui.toast]\ndelivery = "terminal"\n\n[ui.sound]\nenabled = false\n',
    );
  });

  test("replaces an existing delivery without touching its neighbours", () => {
    const config = [
      "[ui.toast]",
      'delivery = "system"',
      "delay_seconds = 2",
      "",
      "[theme]",
      'name = "catppuccin"',
      "",
    ].join("\n");

    expect(forwardNotificationsToTerminal(config)).toBe(
      [
        "[ui.toast]",
        'delivery = "terminal"',
        "delay_seconds = 2",
        "",
        "[theme]",
        'name = "catppuccin"',
        "",
        "[ui.sound]",
        "enabled = false",
        "",
      ].join("\n"),
    );
  });

  test("leaves unrelated settings in place", () => {
    const config = 'onboarding = false\n\n[theme]\nname = "catppuccin"\n';
    const result = forwardNotificationsToTerminal(config);
    expect(result).toStartWith(config);
    expect(result).toContain('delivery = "terminal"');
    expect(result).toContain("enabled = false");
  });
});
