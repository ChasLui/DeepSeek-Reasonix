import { describe, expect, it } from "vitest";
import { shouldRouteHistoryHandoffToChatScroll } from "../src/cli/ui/history-scroll-routing.js";

describe("shouldRouteHistoryHandoffToChatScroll", () => {
  it("routes bare arrows from an empty composer to chat scroll when movement is possible", () => {
    expect(
      shouldRouteHistoryHandoffToChatScroll({
        source: "arrow",
        direction: "prev",
        input: "",
        scrollRows: 5,
        maxScroll: 10,
      }),
    ).toBe(true);

    expect(
      shouldRouteHistoryHandoffToChatScroll({
        source: "arrow",
        direction: "next",
        input: "",
        scrollRows: 5,
        maxScroll: 10,
      }),
    ).toBe(true);
  });

  it("leaves readline history keys and non-empty composer arrows with prompt history", () => {
    expect(
      shouldRouteHistoryHandoffToChatScroll({
        source: "readline",
        direction: "prev",
        input: "",
        scrollRows: 5,
        maxScroll: 10,
      }),
    ).toBe(false);

    expect(
      shouldRouteHistoryHandoffToChatScroll({
        source: "arrow",
        direction: "prev",
        input: "draft",
        scrollRows: 5,
        maxScroll: 10,
      }),
    ).toBe(false);
  });

  it("falls back to prompt history when the chat cannot move in that direction", () => {
    expect(
      shouldRouteHistoryHandoffToChatScroll({
        source: "arrow",
        direction: "prev",
        input: "",
        scrollRows: 0,
        maxScroll: 10,
      }),
    ).toBe(false);

    expect(
      shouldRouteHistoryHandoffToChatScroll({
        source: "arrow",
        direction: "next",
        input: "",
        scrollRows: 10,
        maxScroll: 10,
      }),
    ).toBe(false);
  });
});
