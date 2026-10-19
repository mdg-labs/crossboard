import { describe, expect, it } from "vitest";
import { sanitizeGithubHtml } from "../src/security/index.js";

describe("sanitizeGithubHtml removes what SPEC §9.3 does not allow", () => {
  it("strips a script element and its content", () => {
    const html = sanitizeGithubHtml("<p>a</p><script>alert(1)</script>");
    expect(html).toBe("<p>a</p>");
  });

  it("strips an onerror attribute and keeps the image", () => {
    const html = sanitizeGithubHtml(
      '<img src="https://example.com/a.png" onerror="alert(1)">',
    );
    expect(html).toBe('<img src="https://example.com/a.png" />');
  });

  it("strips every event-handler attribute", () => {
    const html = sanitizeGithubHtml(
      '<p onclick="x()" onmouseover="y()">t</p><a href="https://e.com" onfocus="z()">l</a>',
    );
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("strips style attributes", () => {
    const html = sanitizeGithubHtml('<p style="position:fixed">t</p>');
    expect(html).toBe("<p>t</p>");
  });

  it("strips a style element and its content", () => {
    const html = sanitizeGithubHtml(
      "<style>body{display:none}</style><p>t</p>",
    );
    expect(html).toBe("<p>t</p>");
  });

  it("strips an iframe", () => {
    const html = sanitizeGithubHtml(
      '<iframe src="https://evil.example"></iframe><p>t</p>',
    );
    expect(html).toBe("<p>t</p>");
  });

  it("strips a form and its controls except a task-list checkbox", () => {
    const html = sanitizeGithubHtml(
      '<form action="https://evil.example"><input type="text" name="q"><button>go</button></form>',
    );
    expect(html).not.toMatch(/<form|<input|<button/);
  });

  it("strips the href of a javascript: link", () => {
    const html = sanitizeGithubHtml(
      '<a href="javascript:alert(1)">x</a><a href=" JaVa\nScript:alert(1)">y</a>',
    );
    expect(html).not.toMatch(/javascript/i);
    expect(html).not.toMatch(/href/);
  });

  it("strips a data: link and a relative link", () => {
    const html = sanitizeGithubHtml(
      '<a href="data:text/html,x">d</a><a href="/settings">r</a><a href="//evil.example">p</a>',
    );
    expect(html).not.toMatch(/href/);
  });

  it("drops an image that is not served over https", () => {
    const html = sanitizeGithubHtml(
      '<img src="http://example.com/a.png"><img src="data:image/png;base64,AA"><img src="//example.com/a.png">',
    );
    expect(html).toBe("");
  });

  it("strips a class outside the allowlist", () => {
    const html = sanitizeGithubHtml(
      '<p class="fixed inset-0 markdown-alert evil">t</p>',
    );
    expect(html).toBe('<p class="markdown-alert">t</p>');
  });
});

describe("sanitizeGithubHtml keeps what GitHub renders", () => {
  it("keeps headings, paragraphs, lists, quotes and rules", () => {
    const source =
      "<h1>a</h1><h2>b</h2><h3>c</h3><p>p<br>q</p><ul><li>u</li></ul><ol><li>o</li></ol><blockquote><p>q</p></blockquote><hr>";
    expect(sanitizeGithubHtml(source)).toBe(
      "<h1>a</h1><h2>b</h2><h3>c</h3><p>p<br />q</p><ul><li>u</li></ul><ol><li>o</li></ol><blockquote><p>q</p></blockquote><hr />",
    );
  });

  it("keeps a task-list checkbox, disabled, with its classes", () => {
    const html = sanitizeGithubHtml(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked onclick="x()"> done</li></ul>',
    );
    expect(html).toContain('<li class="task-list-item">');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('class="task-list-item-checkbox"');
    expect(html).toContain('disabled="disabled"');
    expect(html).toContain('checked="checked"');
    expect(html).not.toContain("onclick");
  });

  it("disables a checkbox that arrives enabled", () => {
    expect(sanitizeGithubHtml('<input type="checkbox">')).toContain(
      'disabled="disabled"',
    );
  });

  it("keeps code, pre and highlight and pl classes", () => {
    const source =
      '<div class="highlight highlight-source-js"><pre><code>const <span class="pl-k">x</span></code></pre></div><p><code>y</code></p>';
    expect(sanitizeGithubHtml(source)).toBe(source);
  });

  it("keeps tables", () => {
    const source =
      '<table><thead><tr><th align="left">h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>';
    expect(sanitizeGithubHtml(source)).toBe(source);
  });

  it("keeps details, summary, kbd, sup, sub and del", () => {
    const source =
      "<details><summary>s</summary><kbd>Ctrl</kbd> x<sup>2</sup> y<sub>i</sub> <del>z</del></details>";
    expect(sanitizeGithubHtml(source)).toBe(source);
  });

  it("keeps an https image", () => {
    const source = '<img alt="a" src="https://example.com/a.png" />';
    expect(sanitizeGithubHtml(source)).toBe(source);
  });

  it("keeps markdown-* classes", () => {
    const source = '<div class="markdown-alert markdown-alert-note">n</div>';
    expect(sanitizeGithubHtml(source)).toBe(source);
  });

  it("adds rel and target to links, replacing the ones sent", () => {
    const html = sanitizeGithubHtml(
      '<a href="https://example.com/x" target="_self" rel="opener">x</a><a href="mailto:a@example.com">m</a><a href="http://example.com">h</a>',
    );
    const links = html.match(/<a [^>]*>/g) ?? [];
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link).toContain('rel="noopener noreferrer nofollow"');
      expect(link).toContain('target="_blank"');
      expect(link).not.toContain("_self");
      expect(link).not.toContain('"opener"');
    }
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('href="mailto:a@example.com"');
    expect(html).toContain('href="http://example.com"');
  });
});
