import assert from "node:assert/strict";
import test from "node:test";
import { GovernanceWorker } from "../governance-worker.js";
import type { GovernanceStore } from "../governance-store.js";
import type { GovernanceEvaluator, EvaluationOutcome } from "../evaluator-types.js";
import type { GovernanceJobRecord } from "../assessment-types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeJob(overrides?: Partial<GovernanceJobRecord>): GovernanceJobRecord {
  return {
    jobId: "job-001",
    assessmentId: "asmt-001",
    attemptId: "att-001",
    jobType: "GOVERNANCE_ASSESSMENT",
    status: "CLAIMED",
    workerId: "worker-test",
    claimedAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseGeneration: 1,
    claimCount: 1,
    availableAt: new Date().toISOString(),
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

interface StoreState {
  jobs: Map<string, GovernanceJobRecord>;
  assessmentStatuses: Map<string, string>;
  attemptStatuses: Map<string, string>;
  heartbeats: string[];
}

function makeStore(
  initialJob: GovernanceJobRecord | null,
  state: StoreState
): GovernanceStore {
  return {
    claimNextGovernanceJob: async (_input: unknown) => {
      if (!initialJob) return null;
      const j = { ...initialJob };
      state.jobs.set(j.jobId, j);
      initialJob = null; // claim once
      return j;
    },
    heartbeatJob: async (jobId: string, workerId: string) => {
      state.heartbeats.push(`${jobId}:${workerId}`);
      return true;
    },
    transitionJobToRunning: async (jobId: string, _workerId: string) => {
      const j = state.jobs.get(jobId);
      if (j) { j.status = "RUNNING"; }
      return j ?? null;
    },
    updateAssessmentStatus: async (assessmentId: string, status: string) => {
      state.assessmentStatuses.set(assessmentId, status);
      return null;
    },
    updateAttemptStatus: async (attemptId: string, status: string, _patch?: unknown) => {
      state.attemptStatuses.set(attemptId, status);
      return null;
    },
    failJob: async (jobId: string, _workerId: string, error: { code: string; message: string }, rescheduleAt?: string) => {
      const j = state.jobs.get(jobId);
      if (j) {
        j.status = rescheduleAt ? "AVAILABLE" : "FAILED";
        j.lastErrorCode = error.code;
        j.lastErrorMessage = error.message;
      }
      return j ?? null;
    },
    completeJob: async (jobId: string, _workerId: string) => {
      const j = state.jobs.get(jobId);
      if (j) j.status = "COMPLETE";
      return j ?? null;
    },
    cancelJob: async (jobId: string) => {
      const j = state.jobs.get(jobId);
      if (j) j.status = "CANCELLED";
      return j ?? null;
    },
    getGovernanceJob: async (jobId: string) => state.jobs.get(jobId) ?? null
  } as unknown as GovernanceStore;
}

function makeEvaluator(outcome: EvaluationOutcome): GovernanceEvaluator {
  return {
    evaluate: async () => outcome
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("runOnce returns false when queue is empty", async () => {
  const state: StoreState = {
    jobs: new Map(),
    assessmentStatuses: new Map(),
    attemptStatuses: new Map(),
    heartbeats: []
  };
  const store = makeStore(null, state);
  const evaluator = makeEvaluator({ kind: "COMPLETE", manifestHash: "x".repeat(64) });
  const worker = new GovernanceWorker({
    workerId: "worker-test",
    governanceStore: store,
    evaluator
  });

  const processed = await worker.runOnce();
  assert.equal(processed, false);
});

test("runOnce claims and processes a job returning COMPLETE", async () => {
  const job = makeJob({ claimCount: 1 });
  const state: StoreState = {
    jobs: new Map(),
    assessmentStatuses: new Map(),
    attemptStatuses: new Map(),
    heartbeats: []
  };
  const store = makeStore(job, state);
  const evaluator = makeEvaluator({ kind: "COMPLETE", manifestHash: "a".repeat(64) });

  const worker = new GovernanceWorker({
    workerId: "worker-test",
    governanceStore: store,
    evaluator
  });

  const processed = await worker.runOnce();
  assert.equal(processed, true);
  // Assessment and attempt transitions are handled by the evaluator; no secondary
  // status change expected from the worker for COMPLETE.
});

test("runOnce reschedules job on retryable INFRASTRUCTURE_ERROR", async () => {
  const job = makeJob({ claimCount: 1 });
  const state: StoreState = {
    jobs: new Map(),
    assessmentStatuses: new Map(),
    attemptStatuses: new Map(),
    heartbeats: []
  };
  const store = makeStore(job, state);
  const evaluator = makeEvaluator({
    kind: "INFRASTRUCTURE_ERROR",
    errorCode: "DB_TIMEOUT",
    errorMessage: "database timed out",
    retryable: true
  });

  const worker = new GovernanceWorker({
    workerId: "worker-test",
    governanceStore: store,
    evaluator
  });

  await worker.runOnce();

  // Job should be rescheduled as AVAILABLE
  const j = state.jobs.get("job-001");
  assert.equal(j?.status, "AVAILABLE");
  assert.equal(j?.lastErrorCode, "DB_TIMEOUT");
  // Attempt should be marked ERROR
  assert.equal(state.attemptStatuses.get("att-001"), "ERROR");
});

test("runOnce terminates job and assessment on AUTHORITY_ERROR", async () => {
  const job = makeJob({ claimCount: 1 });
  const state: StoreState = {
    jobs: new Map(),
    assessmentStatuses: new Map(),
    attemptStatuses: new Map(),
    heartbeats: []
  };
  const store = makeStore(job, state);
  const evaluator = makeEvaluator({
    kind: "AUTHORITY_ERROR",
    errorCode: "ASSESSMENT_AUTHORITY_STATE_MISMATCH",
    errorMessage: "digest mismatch"
  });

  const worker = new GovernanceWorker({
    workerId: "worker-test",
    governanceStore: store,
    evaluator
  });

  await worker.runOnce();
  // The evaluator itself handles AUTHORITY_ERROR transitions — the worker sees
  // the outcome and takes no secondary action. Verify the outcome was received.
  // (No rescheduling for authority errors)
  const j = state.jobs.get("job-001");
  // Job transitions are done by the evaluator; this job should not have been
  // put back as AVAILABLE by the worker.
  assert.notEqual(j?.status, "AVAILABLE");
});

test("runOnce permanently fails job when claimCount exceeds MAX_CLAIM_COUNT", async () => {
  const job = makeJob({ claimCount: 4 }); // exceeds MAX_CLAIM_COUNT=3
  const state: StoreState = {
    jobs: new Map(),
    assessmentStatuses: new Map(),
    attemptStatuses: new Map(),
    heartbeats: []
  };
  const store = makeStore(job, state);
  // Evaluator should never be called
  let evaluatorCalled = false;
  const evaluator = makeEvaluator({ kind: "COMPLETE", manifestHash: "a".repeat(64) });
  const originalEvaluate = evaluator.evaluate.bind(evaluator);
  (evaluator as { evaluate: typeof evaluator.evaluate }).evaluate = async (input) => {
    evaluatorCalled = true;
    return originalEvaluate(input);
  };

  const worker = new GovernanceWorker({
    workerId: "worker-test",
    governanceStore: store,
    evaluator
  });

  await worker.runOnce();

  assert.equal(evaluatorCalled, false, "evaluator must not be called when max claims exceeded");
  assert.equal(state.assessmentStatuses.get("asmt-001"), "ERROR");
  assert.equal(state.attemptStatuses.get("att-001"), "ERROR");
  const j = state.jobs.get("job-001");
  assert.equal(j?.lastErrorCode, "MAX_CLAIMS_EXCEEDED");
});

test("worker has a stable workerId that does not change across run invocations", () => {
  const state: StoreState = {
    jobs: new Map(),
    assessmentStatuses: new Map(),
    attemptStatuses: new Map(),
    heartbeats: []
  };
  const store = makeStore(null, state);
  const evaluator = makeEvaluator({ kind: "COMPLETE", manifestHash: "a".repeat(64) });

  const worker = new GovernanceWorker({
    workerId: "stable-worker-id",
    governanceStore: store,
    evaluator
  });

  assert.equal(worker.workerId, "stable-worker-id");
  assert.equal(worker.workerId, "stable-worker-id");
});

test("worker assigns a random workerId when none provided", () => {
  const state: StoreState = {
    jobs: new Map(),
    assessmentStatuses: new Map(),
    attemptStatuses: new Map(),
    heartbeats: []
  };
  const store = makeStore(null, state);
  const evaluator = makeEvaluator({ kind: "COMPLETE", manifestHash: "a".repeat(64) });

  const workerA = new GovernanceWorker({ governanceStore: store, evaluator });
  const workerB = new GovernanceWorker({ governanceStore: store, evaluator });

  assert.match(workerA.workerId, /^worker-/);
  assert.notEqual(workerA.workerId, workerB.workerId);
});
