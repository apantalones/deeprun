import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProfileDigest,
  getProfileDescriptor,
  nodeFastifyPrismaProfileV1,
  normalizeProfileDescriptor
} from "../profiles.js";

test("node-fastify-prisma profile descriptor is registered", () => {
  const profile = getProfileDescriptor({
    id: "node-fastify-prisma",
    version: "1.0.0"
  });

  assert.ok(profile);
  assert.equal(profile.id, "node-fastify-prisma");
  assert.equal(profile.version, "1.0.0");
});

test("profile digest is stable across validator ordering", () => {
  const reversed = {
    ...nodeFastifyPrismaProfileV1,
    validatorSet: [...nodeFastifyPrismaProfileV1.validatorSet].reverse()
  };

  assert.equal(buildProfileDigest(nodeFastifyPrismaProfileV1), buildProfileDigest(reversed));
  assert.deepEqual(
    normalizeProfileDescriptor(reversed).validatorSet.map((validator) => validator.id),
    normalizeProfileDescriptor(nodeFastifyPrismaProfileV1).validatorSet.map((validator) => validator.id)
  );
});

test("profile digest changes when validator version changes", () => {
  const modified = {
    ...nodeFastifyPrismaProfileV1,
    validatorSet: nodeFastifyPrismaProfileV1.validatorSet.map((validator) =>
      validator.id === "canonical.tests"
        ? {
            ...validator,
            version: "2.0.0"
          }
        : validator
    )
  };

  assert.notEqual(buildProfileDigest(nodeFastifyPrismaProfileV1), buildProfileDigest(modified));
});
