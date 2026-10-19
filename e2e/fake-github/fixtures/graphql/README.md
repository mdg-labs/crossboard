One file per GraphQL operation, named after the operation: a request for
`query IssuesPage { … }` is answered with the body of `IssuesPage.json`,
for example `{ "data": { … } }`. A request for an operation without a file
fails, so a missing fixture is never mistaken for an empty answer.

Two other shapes answer an operation by its variables:

- `{ "answerBy": ["owner", "name"], "answers": { "octocat/hello-world": { … } } }`
  answers with the body filed under the values of those variables joined by
  `/`. A request whose values have no body fails.
- `{ "nodesBy": "ids", "rateLimit": { … }, "nodes": { "<node id>": { … } } }`
  answers a `nodes(ids: …)` lookup with the node of each requested id, or
  `null` for an id that has none, as GitHub does for a node it cannot read.

`IssueDetails.json` answers by the `id` variable (the issue's node id) with
the lazily fetched body, comments and sub-issues of the three issues the
detail specs open. `I_e2e_rk_1` carries a `<script>` and an `onclick`
attribute in its body so a spec can show the server strips them.
