import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPlan, PlannerInput } from "../types.js";
import { AgentPlanner } from "../planner.js";

class StubPlanner extends AgentPlanner {
  constructor(private readonly response: AgentPlan) {
    super();
  }

  protected override async requestPlannerJson(): Promise<unknown> {
    return this.response;
  }
}

async function withTempProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-planner-"));
  try {
    await writeFile(path.join(projectRoot, "README.md"), "# temp\n", "utf8");
    return await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function plannerInput(projectRoot: string, goal: string): PlannerInput {
  return {
    goal,
    providerId: "openai",
    model: "test-model",
    projectRoot,
    plannerTimeoutMs: 1_000,
    project: {
      id: "project-1",
      orgId: "org-1",
      workspaceId: "workspace-1",
      createdByUserId: "user-1",
      name: "Planner Test Project",
      description: "planner test project",
      templateId: "agent-workflow",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [],
      messages: []
    }
  };
}

test("planner inserts a modify step when an implementation-intent goal gets a read-only plan", async () => {
  await withTempProject(async (projectRoot) => {
    const planner = new StubPlanner({
      goal: "Implement backend multi-user safety",
      steps: [
        {
          id: "step-1",
          type: "analyze",
          tool: "list_files",
          input: {
            path: ".",
            maxEntries: 50
          }
        },
        {
          id: "step-2",
          type: "analyze",
          tool: "read_file",
          input: {
            path: "README.md"
          }
        }
      ]
    });

    const plan = await planner.plan(plannerInput(projectRoot, "Implement backend multi-user safety"));

    assert.equal(plan.steps.length, 3);
    assert.deepEqual(
      plan.steps.map((step) => step.id),
      ["step-1", "step-2", "step-3"]
    );
    assert.equal(plan.steps[1]?.type, "modify");
    assert.equal(plan.steps[1]?.tool, "ai_mutation");
    assert.equal(plan.steps[1]?.mutates, true);
    assert.match(String(plan.steps[1]?.input.prompt || ""), /Implementation task:/);
  });
});

test("planner preserves read-only plans for analysis-intent goals", async () => {
  await withTempProject(async (projectRoot) => {
    const planner = new StubPlanner({
      goal: "Analyze backend multi-user safety",
      steps: [
        {
          id: "step-1",
          type: "analyze",
          tool: "list_files",
          input: {
            path: ".",
            maxEntries: 50
          }
        },
        {
          id: "step-2",
          type: "analyze",
          tool: "read_file",
          input: {
            path: "README.md"
          }
        }
      ]
    });

    const plan = await planner.plan(plannerInput(projectRoot, "Analyze backend multi-user safety"));

    assert.equal(plan.steps.length, 2);
    assert.ok(plan.steps.every((step) => step.type === "analyze"));
  });
});

test("planner does not inject an extra modify step when one already exists", async () => {
  await withTempProject(async (projectRoot) => {
    const planner = new StubPlanner({
      goal: "Implement backend multi-user safety",
      steps: [
        {
          id: "step-1",
          type: "analyze",
          tool: "list_files",
          input: {
            path: ".",
            maxEntries: 50
          }
        },
        {
          id: "step-2",
          type: "modify",
          tool: "ai_mutation",
          mutates: true,
          input: {
            mode: "generate",
            prompt: "Implement backend multi-user safety"
          }
        }
      ]
    });

    const plan = await planner.plan(plannerInput(projectRoot, "Implement backend multi-user safety"));

    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps.filter((step) => step.type === "modify").length, 1);
  });
});

test("planner fills missing ai_mutation prompt for implementation plans", async () => {
  await withTempProject(async (projectRoot) => {
    const planner = new StubPlanner({
      goal: "Implement backend multi-user safety",
      steps: [
        {
          id: "step-1",
          type: "analyze",
          tool: "list_files",
          input: {
            path: ".",
            maxEntries: 50
          }
        },
        {
          id: "step-2",
          type: "modify",
          tool: "ai_mutation",
          mutates: true,
          input: {
            mode: "generate"
          }
        }
      ]
    });

    const plan = await planner.plan(plannerInput(projectRoot, "Implement backend multi-user safety"));

    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[1]?.tool, "ai_mutation");
    assert.equal(plan.steps[1]?.mutates, true);
    assert.match(String(plan.steps[1]?.input.prompt || ""), /Implementation task: Implement backend multi-user safety/);
  });
});
