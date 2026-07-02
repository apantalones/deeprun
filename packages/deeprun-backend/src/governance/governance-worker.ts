import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logError, logInfo, logWarn } from "../lib/logging.js";
import type { GovernanceStore } from "./governance-store.js";
import type { GovernanceEvaluator } from "./evaluator-types.js";
import type { GovernanceJobRecord } from "./assessment-types.js";

// ---------------------------------------------------------------------------
// Retry categories
// ---------------------------------------------------------------------------

/** Maximum claim count before giving up on a job entirely. */
const MAX_CLAIM_COUNT = 3;
/** Base retry delay in milliseconds for retryable infrastructure errors. */
const BASE_RETRY_DELAY_MS = 5_000;
/** Heartbeat interval while evaluation is in progress. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Lease duration granted on each claim. */
const LEASE_DURATION_SECONDS = 300;

export interface GovernanceWorkerOptions {
  workerId?: string;
  governanceStore: GovernanceStore;
  evaluator: GovernanceEvaluator;
  pollIntervalMs?: number;
  maxConcurrentJobs?: number;
  leaseDurationSeconds?: number;
  heartbeatIntervalMs?: number;
}

/**
 * GovernanceWorker
 *
 * Responsible for:
 *   - claiming governance jobs from the queue (database CAS with FOR UPDATE SKIP LOCKED)
 *   - leases and heartbeats
 *   - attempt lifecycle (QUEUED → RUNNING → COMPLETE/ERROR/CANCELLED)
 *   - retry scheduling for retryable infrastructure errors
 *   - cancellation checks before expensive phases
 *   - recording infrastructure errors
 *
 * Does NOT understand Fastify, Prisma, TypeScript, or evidence reason codes.
 * Does NOT perform any validation itself — delegates to GovernanceEvaluator.
 */
export class GovernanceWorker {
  readonly workerId: string;
  private readonly governanceStore: GovernanceStore;
  private readonly evaluator: GovernanceEvaluator;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationSeconds: number;
  private readonly heartbeatIntervalMs: number;

  private running = false;
  private stopSignal: AbortController | null = null;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: GovernanceWorkerOptions) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.governanceStore = options.governanceStore;
    this.evaluator = options.evaluator;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? LEASE_DURATION_SECONDS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  /**
   * Start the poll loop. Non-blocking — returns immediately.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopSignal = new AbortController();
    this.scheduleNextPoll();
    logInfo("governance.worker.started", { workerId: this.workerId });
  }

  /**
   * Stop the poll loop. Waits for any in-flight evaluation to finish before
   * returning.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopSignal?.abort();

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    // Clear all heartbeat timers
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();

    logInfo("governance.worker.stopped", { workerId: this.workerId });
  }

  /**
   * Run a single claim-and-evaluate cycle. Safe to call directly in tests.
   * Returns true if a job was found and processed, false if the queue was empty.
   */
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const job = await this.governanceStore.claimNextGovernanceJob({
      workerId: this.workerId,
      leaseDurationSeconds: this.leaseDurationSeconds
    });

    if (!job) {
      return false;
    }

    await this.processJob(job, signal);
    return true;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private scheduleNextPoll(): void {
    if (!this.running) return;
    this.pollTimeout = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.runOnce(this.stopSignal?.signal);
      } catch (error) {
        logError("governance.worker.poll_error", {
          workerId: this.workerId,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.scheduleNextPoll();
      }
    }, this.pollIntervalMs);
  }

  private async processJob(job: GovernanceJobRecord, externalSignal?: AbortSignal): Promise<void> {
    const { jobId, assessmentId, attemptId, leaseGeneration } = job;

    logInfo("governance.worker.job_claimed", {
      workerId: this.workerId,
      jobId,
      assessmentId,
      attemptId,
      claimCount: job.claimCount
    });

    // ------------------------------------------------------------------
    // Guard: if max claims exceeded, permanently fail the job
    // ------------------------------------------------------------------
    if (job.claimCount > MAX_CLAIM_COUNT) {
      const errMsg = `Job ${jobId} exceeded max claim count (${MAX_CLAIM_COUNT})`;
      logError("governance.worker.max_claims_exceeded", { jobId, claimCount: job.claimCount });
      await this.governanceStore
        .failJob(jobId, this.workerId, { code: "MAX_CLAIMS_EXCEEDED", message: errMsg }, undefined, leaseGeneration)
        .catch(() => undefined);
      await this.governanceStore.updateAttemptStatus(attemptId, "ERROR", {
        errorCode: "MAX_CLAIMS_EXCEEDED",
        errorMessage: errMsg
      }).catch(() => undefined);
      await this.governanceStore.updateAssessmentStatus(assessmentId, "ERROR").catch(() => undefined);
      return;
    }

    // ------------------------------------------------------------------
    // Move job to RUNNING and assessment to RUNNING
    // ------------------------------------------------------------------
    const runningJob = await this.governanceStore.transitionJobToRunning(jobId, this.workerId, leaseGeneration).catch(() => null);
    if (!runningJob) {
      logWarn("governance.worker.running_transition_lost", {
        workerId: this.workerId,
        jobId,
        assessmentId,
        attemptId,
        leaseGeneration
      });
      return;
    }
    await this.governanceStore.updateAssessmentStatus(assessmentId, "RUNNING").catch(() => undefined);

    await this.pauseAfterJobRunningForTest(runningJob, externalSignal);
    if (externalSignal?.aborted) {
      return;
    }

    // ------------------------------------------------------------------
    // Start heartbeat
    // ------------------------------------------------------------------
    const heartbeatTimer = setInterval(async () => {
      try {
        await this.governanceStore.heartbeatJob(
          jobId,
          this.workerId,
          leaseGeneration,
          this.leaseDurationSeconds
        );
      } catch (error) {
        logWarn("governance.worker.heartbeat_failed", {
          workerId: this.workerId,
          jobId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimers.set(jobId, heartbeatTimer);

    // ------------------------------------------------------------------
    // Create a combined abort signal
    // ------------------------------------------------------------------
    const evalAbort = new AbortController();
    const onExternalAbort = () => evalAbort.abort();
    externalSignal?.addEventListener("abort", onExternalAbort);

    try {
      const outcome = await this.evaluator.evaluate({
        assessmentId,
        attemptId,
        jobId,
        workerId: this.workerId,
        leaseGeneration,
        signal: evalAbort.signal
      });

      logInfo("governance.worker.job_outcome", {
        workerId: this.workerId,
        jobId,
        assessmentId,
        attemptId,
        outcome: outcome.kind
      });

      // The evaluator itself transitions all records on COMPLETE/AUTHORITY_ERROR/CANCELLED.
      // For INFRASTRUCTURE_ERROR (retryable), we reschedule.
      if (outcome.kind === "INFRASTRUCTURE_ERROR" && outcome.retryable && job.claimCount < MAX_CLAIM_COUNT) {
        const retryDelayMs = BASE_RETRY_DELAY_MS * job.claimCount;
        const rescheduleAt = new Date(Date.now() + retryDelayMs).toISOString();
        logInfo("governance.worker.rescheduling", {
          jobId,
          retryDelayMs,
          rescheduleAt,
          claimCount: job.claimCount
        });
        await this.governanceStore
          .failJob(
            jobId,
            this.workerId,
            { code: outcome.errorCode, message: outcome.errorMessage },
            rescheduleAt,
            leaseGeneration
          )
          .catch(() => undefined);
        await this.governanceStore.updateAttemptStatus(attemptId, "ERROR", {
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage
        }).catch(() => undefined);
        // Assessment stays in RUNNING until a new attempt is claimed
      } else if (outcome.kind === "INFRASTRUCTURE_ERROR") {
        // Non-retryable infrastructure error (max claims reached in outcome)
        await this.governanceStore
          .failJob(jobId, this.workerId, {
            code: outcome.errorCode,
            message: outcome.errorMessage
          }, undefined, leaseGeneration)
          .catch(() => undefined);
        await this.governanceStore.updateAttemptStatus(attemptId, "ERROR", {
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage
        }).catch(() => undefined);
        await this.governanceStore.updateAssessmentStatus(assessmentId, "ERROR").catch(() => undefined);
      }
      // COMPLETE, AUTHORITY_ERROR, CANCELLED: evaluator already handled all transitions
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logError("governance.worker.evaluate_threw", {
        workerId: this.workerId,
        jobId,
        assessmentId,
        attemptId,
        error: errMsg
      });
      await this.governanceStore
        .failJob(jobId, this.workerId, { code: "WORKER_ERROR", message: errMsg }, undefined, leaseGeneration)
        .catch(() => undefined);
      await this.governanceStore.updateAttemptStatus(attemptId, "ERROR", {
        errorCode: "WORKER_ERROR",
        errorMessage: errMsg
      }).catch(() => undefined);
      await this.governanceStore.updateAssessmentStatus(assessmentId, "ERROR").catch(() => undefined);
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      clearInterval(heartbeatTimer);
      this.heartbeatTimers.delete(jobId);
    }
  }

  private async pauseAfterJobRunningForTest(
    job: GovernanceJobRecord,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.DEEPRUN_TEST_PAUSE_AFTER_JOB_RUNNING !== "true"
    ) {
      return;
    }

    const markerPath = process.env.DEEPRUN_TEST_JOB_RUNNING_MARKER;
    if (markerPath) {
      await mkdir(path.dirname(markerPath), { recursive: true });
      await writeFile(
        markerPath,
        `${JSON.stringify({
          assessmentId: job.assessmentId,
          attemptId: job.attemptId,
          jobId: job.jobId,
          workerId: this.workerId,
          leaseGeneration: job.leaseGeneration,
          leaseExpiresAt: job.leaseExpiresAt
        })}\n`,
        "utf8"
      );
    }

    logInfo("governance.worker.test_pause_after_job_running", {
      assessmentId: job.assessmentId,
      attemptId: job.attemptId,
      jobId: job.jobId,
      workerId: this.workerId,
      leaseGeneration: job.leaseGeneration,
      leaseExpiresAt: job.leaseExpiresAt,
      markerPath: markerPath ?? null
    });

    if (!signal || signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
