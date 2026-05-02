import { describe, expect, test } from "bun:test";
import { htmlToTerminalText } from "./render-html.ts";

describe("htmlToTerminalText", () => {
  test("decodes common HTML entities", () => {
    expect(htmlToTerminalText("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(htmlToTerminalText("&lt;not a tag&gt;")).toBe("<not a tag>");
    expect(htmlToTerminalText("non&#8209;breaking")).toBe("non‑breaking");
  });

  test("checkbox inputs become [x] / [ ] markers", () => {
    expect(
      htmlToTerminalText('<input type="checkbox" checked> Done thing'),
    ).toBe("[x]  Done thing");
    expect(
      htmlToTerminalText('<input type="checkbox"> Pending thing'),
    ).toBe("[ ]  Pending thing");
  });

  test("Apple-style <li class=checked> renders as [x]", () => {
    const out = htmlToTerminalText(
      '<ul><li class="checked">Done</li><li class="unchecked">Todo</li></ul>',
    );
    expect(out).toContain("[x] Done");
    expect(out).toContain("[ ] Todo");
  });

  test("plain <li> becomes a bullet", () => {
    const out = htmlToTerminalText("<ul><li>Apples</li><li>Bananas</li></ul>");
    expect(out).toContain("• Apples");
    expect(out).toContain("• Bananas");
  });

  test("paragraphs and <br> become newlines", () => {
    const out = htmlToTerminalText("<p>One</p><p>Two</p>three<br>four");
    expect(out).toBe("One\n\nTwo\n\nthree\nfour");
  });

  test("Apple-style <div> rows render as adjacent lines, not blank-separated", () => {
    // Apple Notes emits each visible row as a <div>, with a literal newline
    // between tags. We must not insert a blank line between them.
    const html = "<div>First</div>\n<div>Second</div>\n<div>Third</div>";
    expect(htmlToTerminalText(html)).toBe("First\nSecond\nThird");
  });

  test("<div><br></div> renders as a single blank line between rows", () => {
    const html =
      "<div>A</div>\n<div><br></div>\n<div>B</div>";
    expect(htmlToTerminalText(html)).toBe("A\n\nB");
  });

  test("headers get a blank-line buffer", () => {
    const out = htmlToTerminalText("<h1>Title</h1><p>Body</p>");
    expect(out).toContain("Title");
    expect(out.indexOf("Body")).toBeGreaterThan(out.indexOf("Title"));
  });

  test("strips formatting tags but keeps inner text", () => {
    expect(
      htmlToTerminalText('<p><b>Bold</b> and <i>italic</i></p>'),
    ).toBe("Bold and italic");
  });

  test("collapses 3+ consecutive newlines to two", () => {
    const out = htmlToTerminalText("<p>a</p><br><br><br><p>b</p>");
    expect(out).toBe("a\n\nb");
  });
});
