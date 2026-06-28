# Profile Descriptor Contract

A profile is not just a string. It is a versioned descriptor that binds a public profile name to a concrete validator set.

## Schema

```ts
interface ProfileDescriptor {
  profileSchemaVersion: 1;
  id: string;
  version: string;
  validatorSet: Array<{
    id: string;
    version: string;
    implementationDigest?: string;
  }>;
}
```

The profile digest is the SHA-256 hash of the normalized descriptor. Validator entries are sorted by `id` and `version` before hashing so descriptor identity does not depend on insertion order.

## Initial Registered Profile

`node-fastify-prisma@1.0.0` currently binds:

- `canonical-structure@1.0.0`
- `dependency-graph@1.0.0`
- `security-baseline@1.0.0`
- `typescript-build@1.0.0`
- `vitest@1.0.0`
- `runtime-health@1.0.0`

Future evidence records should include the profile digest and validator implementation digests so `node-fastify-prisma@1.0.0` cannot silently change meaning when validator code changes.
