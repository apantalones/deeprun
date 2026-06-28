import type { Digest, SourceTreeManifest } from "./artifacts.js";

export interface ArtifactBlobRecord {
  blobDigest: Digest;
  storageKey: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SourceTreeRecord {
  sourceTreeDigest: Digest;
  manifestSchemaVersion: number;
  manifest: SourceTreeManifest;
  manifestHash: string;
  normalizedBundleDigest: Digest;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

export interface ArtifactRecord {
  artifactId: string;
  organizationId: string;
  blobDigest: Digest;
  sourceTreeDigest: Digest;
  originalFilename?: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateArtifactRecordInput {
  artifactId: string;
  organizationId: string;
  blob: ArtifactBlobRecord;
  sourceTree: SourceTreeRecord;
  originalFilename?: string;
  createdBy: string;
}

export type ArtifactIdempotencyClaimResult =
  | {
      kind: "CLAIMED";
      claimGeneration: number;
      claimOwner: string;
      expiresAt: string;
    }
  | {
      kind: "REPLAYED";
      artifact: ArtifactRecord;
    }
  | {
      kind: "IN_PROGRESS";
      retryAfterSeconds: number;
    }
  | {
      kind: "CONFLICT";
    };

export interface ClaimArtifactIngestionInput {
  organizationId: string;
  idempotencyKey: string;
  expectedBlobDigest: string;
  claimOwner: string;
  leaseDurationSeconds?: number;
}

export interface CompleteArtifactIngestionClaimInput extends CreateArtifactRecordInput {
  idempotency: {
    organizationId: string;
    idempotencyKey: string;
    expectedBlobDigest: string;
    claimGeneration: number;
    claimOwner: string;
  };
}

export interface ArtifactRepository {
  createArtifact(input: CreateArtifactRecordInput): Promise<ArtifactRecord>;
  getArtifactForOrganization(artifactId: string, organizationId: string): Promise<ArtifactRecord | null>;
  getSourceTree(sourceTreeDigest: Digest): Promise<SourceTreeRecord | null>;
}
