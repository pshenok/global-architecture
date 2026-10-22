# ga-platform (Claude Code plugin)

Skills that teach Claude Code (and developers) how to build on the global-architecture
platform. They are the executable part of the platform specification.

| Skill                      | Use it for                                                |
| -------------------------- | --------------------------------------------------------- |
| `ga-architecture`          | the map: layout, layers, conventions, which skill to use  |
| `ga-new-service`           | a new microservice from the template                      |
| `ga-grpc-contracts`        | `.proto` design, versioning, codegen, runtime quirks      |
| `ga-domain-logic`          | aggregates, invariants, use cases, ports, errors          |
| `ga-database`              | Drizzle schema, migrations, constraints, transactions     |
| `ga-service-communication` | gRPC calls between services, error mapping, no cycles     |
| `ga-gateway-endpoint`      | public REST endpoints, OpenAPI, problem+json              |
| `ga-testing`               | unit, use-case, gRPC + Postgres integration, gateway, e2e |
| `ga-local-stack`           | run and debug everything locally                          |
| `ga-code-review`           | review checklist                                          |
| `ga-platform-maintenance`  | dependency upgrades, kit/template changes, sharp edges    |

## Install

Inside this repository the skills load automatically (`.claude/skills` links to them).
To use them in another project:

```text
/plugin marketplace add pshenok/global-architecture
/plugin install ga-platform@global-architecture
```

The skill files live only here (`plugins/ga-platform/skills`); `.claude/skills/*` are
symlinks, so there is one source of truth. Edit the files here.
