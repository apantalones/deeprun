import { createHash } from "node:crypto";
import { z } from "zod";

export const PROFILE_SCHEMA_VERSION = 1 as const;

export const validatorDescriptorSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  implementationDigest: z.string().min(1).optional()
});

export const profileDescriptorSchema = z.object({
  profileSchemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.string().min(1),
  validatorSet: z.array(validatorDescriptorSchema).min(1)
});

export type ValidatorDescriptor = z.infer<typeof validatorDescriptorSchema>;
export type ProfileDescriptor = z.infer<typeof profileDescriptorSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function normalizeProfileDescriptor(profile: ProfileDescriptor): ProfileDescriptor {
  const parsed = profileDescriptorSchema.parse(profile);
  return {
    ...parsed,
    validatorSet: [...parsed.validatorSet].sort(
      (left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
    )
  };
}

export function buildProfileDigest(profile: ProfileDescriptor): string {
  return createHash("sha256").update(canonicalJson(normalizeProfileDescriptor(profile))).digest("hex");
}

export const nodeFastifyPrismaProfileV1: ProfileDescriptor = {
  profileSchemaVersion: PROFILE_SCHEMA_VERSION,
  id: "node-fastify-prisma",
  version: "1.0.0",
  validatorSet: [
    {
      id: "canonical.structure",
      version: "1.0.0"
    },
    {
      id: "canonical.dependencies",
      version: "1.0.0"
    },
    {
      id: "canonical.prisma",
      version: "1.0.0"
    },
    {
      id: "canonical.typecheck",
      version: "1.0.0"
    },
    {
      id: "canonical.build",
      version: "1.0.0"
    },
    {
      id: "canonical.tests",
      version: "1.0.0"
    },
    {
      id: "canonical.runtime-health",
      version: "1.0.0"
    }
  ]
};

export function getProfileDescriptor(input: { id: string; version: string }): ProfileDescriptor | null {
  if (input.id === nodeFastifyPrismaProfileV1.id && input.version === nodeFastifyPrismaProfileV1.version) {
    return nodeFastifyPrismaProfileV1;
  }

  return null;
}
