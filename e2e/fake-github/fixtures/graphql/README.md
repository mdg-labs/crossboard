One file per GraphQL operation, named after the operation: a request for
`query IssuesPage { … }` is answered with the body of `IssuesPage.json`,
for example `{ "data": { … } }`. A request for an operation without a file
fails, so a missing fixture is never mistaken for an empty answer.
