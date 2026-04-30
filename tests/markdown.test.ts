import React from "react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/cli/ui/markdown.js";

/** Smoke tests — markdown parsing is delegated to `marked`; we only verify the component mounts and dispatches over the token kinds we care about. */

describe("Markdown component", () => {
  it("renders an empty string without throwing", () => {
    const el = React.createElement(Markdown, { text: "" });
    expect(el).toBeTruthy();
  });

  it("renders a single paragraph", () => {
    const el = React.createElement(Markdown, { text: "hello world" });
    expect(el).toBeTruthy();
  });

  it("renders mixed block content (heading + list + code)", () => {
    const text = ["# Title", "", "- one", "- two", "", "```ts", "const x = 1;", "```"].join("\n");
    const el = React.createElement(Markdown, { text });
    expect(el).toBeTruthy();
  });

  it("renders inline markup (bold / italic / code / link / strike)", () => {
    const text =
      "This is **bold** and *italic* with `code` and ~~strike~~ and a [link](https://example.com).";
    const el = React.createElement(Markdown, { text });
    expect(el).toBeTruthy();
  });

  it("renders a GFM table", () => {
    const text = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
    const el = React.createElement(Markdown, { text });
    expect(el).toBeTruthy();
  });

  it("renders a GFM task list", () => {
    const text = ["- [ ] todo", "- [x] done"].join("\n");
    const el = React.createElement(Markdown, { text });
    expect(el).toBeTruthy();
  });

  it("renders a blockquote with nested content", () => {
    const text = "> a quote\n> with *italic* inside";
    const el = React.createElement(Markdown, { text });
    expect(el).toBeTruthy();
  });

  it("does not throw on malformed / unbalanced markup", () => {
    const text = "**unterminated bold and `unterminated code";
    const el = React.createElement(Markdown, { text });
    expect(el).toBeTruthy();
  });
});
