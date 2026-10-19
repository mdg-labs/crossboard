import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "div",
  "span",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "input",
  "code",
  "pre",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "details",
  "summary",
  "kbd",
  "sup",
  "sub",
  "del",
  "em",
  "strong",
];

const LINK_HREF = /^(?:https?|mailto):/i;
const IMAGE_SRC = /^https:\/\//i;

/**
 * Sanitizes GitHub's rendered HTML (`bodyHTML`) with the GitHub-like allowlist
 * of SPEC §9.3. Everything that is not named there is removed: scripts,
 * styles, iframes, forms, event-handler and `style` attributes, links that
 * are not http, https or mailto, images that are not https, and every class
 * outside `markdown-*`, `highlight*`, `pl-*` and `task-list-item*`.
 */
export function sanitizeGithubHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "rel", "target"],
      img: ["src", "alt", "title", "width", "height"],
      input: ["type", "checked", "disabled"],
      th: ["align"],
      td: ["align"],
      details: ["open"],
    },
    allowedClasses: {
      "*": ["markdown-*", "highlight*", "pl-*", "task-list-item*"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (tagName, attribs) => {
        const { href, ...rest } = attribs;
        return {
          tagName,
          attribs: {
            ...rest,
            ...(href !== undefined && LINK_HREF.test(href) ? { href } : {}),
            rel: "noopener noreferrer nofollow",
            target: "_blank",
          },
        };
      },
      img: (tagName, attribs) => {
        const { src, ...rest } = attribs;
        return {
          tagName,
          attribs: {
            ...rest,
            ...(src !== undefined && IMAGE_SRC.test(src) ? { src } : {}),
          },
        };
      },
      input: (tagName, attribs) => {
        const { checked, ...rest } = attribs;
        return {
          tagName,
          attribs: {
            ...rest,
            disabled: "disabled",
            ...(checked === undefined ? {} : { checked: "checked" }),
          },
        };
      },
    },
    exclusiveFilter: (frame) =>
      (frame.tag === "input" && frame.attribs.type !== "checkbox") ||
      (frame.tag === "img" && frame.attribs.src === undefined),
  });
}
