import { createWorkflow, createStep } from "@mastra/core";
import z from "zod";
import { testDockerStep, testDockerGithubCloneStep, postProjectDescriptionStep, postProjectStackStep, saveContextStep as dockerSaveContextStep } from "./test/01-docker-test-workflow";
import { workflowStartStep as gatherStartStep, analyzeRepositoryStep, analyzeCodebaseStep, analyzeBuildDeploymentStep, synthesizeContextStep, saveContextStep as gatherSaveContextStep, validateAndReturnStep as gatherValidateAndReturnStep } from "./test/02-gather-context-workflow";
import { checkSavedPlanStep, loadContextAndPlanStep, generateTestCodeStep, finalizeStep } from "./test/03-generate-unit-tests-workflow";
import { prepareCommitAndPushStep, createPullRequestStep, postPrUrlStep } from "./test/04-github-pr-workflow";
 

// Input for the pipeline (optional context to seed into the container)
const PipelineInput = z.object({
    contextData: z.any().optional().describe("Optional context data to save to the container during docker setup"),
    repositoryUrl: z.string().optional().describe("Optional repository URL or owner/repo format (e.g., 'owner/repo' or 'https://github.com/owner/repo')"),
    projectId: z.string().describe("Project ID associated with this workflow run"),
});

// Minimal aggregated output schema to report end-to-end results
const PipelineOutput = z.object({
    result: z.string(),
    success: z.boolean(),
    toolCallCount: z.number(),
    containerId: z.string(),
    contextPath: z.string().optional(),
    projectId: z.string(),
    prUrl: z.string(),
});

export const fullPipelineWorkflow = createWorkflow({
    id: "full-pipeline-workflow",
    description: "End-to-end pipeline: Docker setup → Context gather → Unit test generation",
    inputSchema: PipelineInput,
    outputSchema: PipelineOutput,
})
.then(testDockerStep)
.then(testDockerGithubCloneStep)
.parallel([postProjectDescriptionStep as any, postProjectStackStep as any])
.then(dockerSaveContextStep)
.then(gatherStartStep as any)
.parallel([analyzeRepositoryStep as any, analyzeCodebaseStep as any, analyzeBuildDeploymentStep as any])
.then(synthesizeContextStep)
.then(gatherSaveContextStep)
.then(checkSavedPlanStep as any)
.then(loadContextAndPlanStep)
.then(generateTestCodeStep)
.then(finalizeStep as any)
// 04 - GitHub PR steps
.then(prepareCommitAndPushStep as any)
.then(createPullRequestStep as any)
.then(postPrUrlStep as any)
.then(createStep({
    id: "full-pipeline-output-normalizer",
    inputSchema: z.any(),
    outputSchema: PipelineOutput,
    execute: async ({ inputData }) => {
        return {
            result: inputData?.result || "Pipeline completed",
            success: inputData?.success ?? true,
            toolCallCount: inputData?.toolCallCount ?? 0,
            containerId: inputData?.containerId || "",
            contextPath: inputData?.contextPath,
            projectId: inputData?.projectId || "",
            prUrl: inputData?.prUrl || "",
        };
    },
}))
.commit();


