/**
 * Static identity of a gRPC service: what it is called and which contracts it serves.
 * Defined once in `src/service.ts` and shared by the AppModule and main.ts.
 */
export interface ServiceDefinition {
  /** kebab-case name, e.g. `user-service`. Used in logs, error domains and DB application_name. */
  readonly name: string;
  /** Proto files it serves, relative to the contracts proto root, e.g. `ga/user/v1/user.proto`. */
  readonly protoFiles: readonly string[];
  /** Proto packages it implements, e.g. `ga.user.v1`. */
  readonly packages: readonly string[];
  /** Fully-qualified gRPC services it implements, e.g. `ga.user.v1.UserService`. */
  readonly services: readonly string[];
}

/** DI token of the {@link ServiceDefinition}. */
export const SERVICE_DEFINITION = Symbol('SERVICE_DEFINITION');

const NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const FQN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.v\d+\.[A-Z]\w*Service$/;

export function defineService(definition: ServiceDefinition): ServiceDefinition {
  if (!NAME.test(definition.name)) {
    throw new TypeError(`service name must be kebab-case, got "${definition.name}"`);
  }
  for (const service of definition.services) {
    if (!FQN.test(service)) {
      throw new TypeError(
        `"${service}" is not a fully-qualified versioned service (e.g. ga.user.v1.UserService)`,
      );
    }
    if (!definition.packages.some((pkg) => service.startsWith(`${pkg}.`))) {
      throw new TypeError(`service "${service}" is not in any declared package`);
    }
  }
  return Object.freeze({
    name: definition.name,
    protoFiles: Object.freeze([...definition.protoFiles]),
    packages: Object.freeze([...definition.packages]),
    services: Object.freeze([...definition.services]),
  });
}
