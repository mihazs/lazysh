---
"@lazysh/client": minor
---

feat(herdr): report a Herdr with a changed API schema as limited instead of fully supported

Discovery reads `schema_version` from `herdr api schema` (print-only, never starts a server) next to the version. A host whose Herdr reports a schema other than 1 is limited to navigation, and the Sessions panel names the schema.
