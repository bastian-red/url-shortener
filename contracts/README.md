# contracts

Shapes that cross a language boundary. `services/redirect` is Go and everything
else is TypeScript, so neither side can import the other's types; these JSON
Schemas are the authority both sides test against.

| Schema | Writer | Reader | Golden fixture |
|---|---|---|---|
| `click-event.schema.json` | redirect (Go) `XADD clicks` | click-worker (Node) | `fixtures/click-event.json` |
| `link-cache.schema.json` | api (Node) write-through, redirect (Go) on a miss | redirect (Go) | `fixtures/link-cache.json` |
| `health.schema.json` | all three services | web `/status`, E2E | `fixtures/health.json` |

Held by:

- `packages/shared/src/contracts/cross-language.test.ts` - each fixture validates
  against its JSON Schema (ajv) **and** its zod schema, and the two schemas
  declare the same field set.
- `services/redirect/internal/contract/contract_test.go` - the Go encoder's output
  validates against the same JSON Schema, and the Go decoder reads the fixture.

Changing a shape means editing the schema, the zod schema, the Go struct and the
fixture in one commit, and bumping `v` for the click event.
