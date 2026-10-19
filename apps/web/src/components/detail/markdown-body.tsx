/**
 * The only place the SPA injects HTML (the lint rule exempts this file). It
 * takes the sanitized `bodyHtml` of the details route (SPEC FR-41, §9.3) and
 * nothing else.
 */
export function MarkdownBody({ html }: { html: string }): React.ReactElement {
  return (
    <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
