import { GithubDocumentError } from "./errors.js";

/** A GraphQL document with the name it is logged under. */
export interface GithubQuery {
  readonly name: string;
  readonly document: string;
}

const WORD = /[_A-Za-z0-9]/;
const ALLOWED_DEFINITIONS = new Set(["query", "fragment"]);

/**
 * Throws unless every definition in the document is a query (a `{ … }`
 * shorthand, a `query` operation) or a fragment. The check reads the document
 * the way the GraphQL lexer does, skipping comments and strings, so a
 * `mutation` or `subscription` keyword cannot be hidden from it and is
 * refused wherever it starts a definition (D-18). A document it cannot read
 * to the end is refused too.
 */
export function assertReadOnlyDocument(document: string): void {
  const refuse = (reason: string): never => {
    throw new GithubDocumentError(`refusing a GraphQL document: ${reason}`);
  };
  let depth = 0;
  let atDefinition = true;
  let definitions = 0;
  let i = 0;
  while (i < document.length) {
    const char = document.charAt(i);
    if (char === "#") {
      while (i < document.length && !"\n\r".includes(document.charAt(i))) i++;
    } else if (document.startsWith('"""', i)) {
      i += 3;
      while (i < document.length && !document.startsWith('"""', i)) {
        i += document.startsWith('\\"""', i) ? 4 : 1;
      }
      if (i >= document.length) refuse("unterminated block string");
      i += 3;
    } else if (char === '"') {
      i++;
      while (i < document.length && document.charAt(i) !== '"') {
        if (document.charAt(i) === "\n") refuse("unterminated string");
        i += document.charAt(i) === "\\" ? 2 : 1;
      }
      if (i >= document.length) refuse("unterminated string");
      i++;
    } else if (char === "{" || char === "(" || char === "[") {
      if (depth === 0 && char === "{" && atDefinition) {
        atDefinition = false;
        definitions++;
      }
      depth++;
      i++;
    } else if (char === "}" || char === ")" || char === "]") {
      depth--;
      if (depth < 0) refuse("unbalanced brackets");
      if (depth === 0 && char === "}") atDefinition = true;
      i++;
    } else if (WORD.test(char)) {
      const start = i;
      while (i < document.length && WORD.test(document.charAt(i))) i++;
      const word = document.slice(start, i);
      if (depth === 0 && atDefinition) {
        if (!ALLOWED_DEFINITIONS.has(word)) {
          refuse(`only query operations may be sent, found "${word}"`);
        }
        atDefinition = false;
        definitions++;
      }
    } else {
      i++;
    }
  }
  if (depth !== 0) refuse("unbalanced brackets");
  if (definitions === 0) refuse("it holds no operation");
}

/** Octokit request options that would change the method, host or headers the route names. */
const RESERVED_REQUEST_OPTIONS = new Set([
  "method",
  "url",
  "baseurl",
  "headers",
  "request",
  "mediatype",
]);

/**
 * Throws unless the call is a REST `GET` to the configured host: the route
 * must start with `GET `, and `params` may not carry an option that Octokit
 * lets override the route's method, URL, host or headers. These are the only
 * REST calls made with an installation token.
 */
export function assertGetRoute(
  route: string,
  params?: Record<string, unknown>,
): void {
  if (!route.startsWith("GET ")) {
    throw new GithubDocumentError(
      "only GET routes may be sent with an installation token",
    );
  }
  for (const key of Object.keys(params ?? {})) {
    if (RESERVED_REQUEST_OPTIONS.has(key.toLowerCase())) {
      throw new GithubDocumentError(
        `request option "${key}" may not be set on a GET route`,
      );
    }
  }
}
