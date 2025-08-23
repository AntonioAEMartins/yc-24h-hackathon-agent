import { createWorkflow } from "@mastra/core";
import z from "zod";
import { testDockerStep, testDockerGithubCloneStep, saveContextStep as dockerSaveContextStep } from "./test/01-docker-test-workflow";
import { workflowStartStep as gatherStartStep, analyzeRepositoryStep, analyzeCodebaseStep, analyzeBuildDeploymentStep, synthesizeContextStep, saveContextStep as gatherSaveContextStep, validateAndReturnStep as gatherValidateAndReturnStep } from "./test/02-gather-context-workflow";
import { checkSavedPlanStep, loadContextAndPlanStep, generateTestCodeStep, finalizeStep } from "./test/03-generate-unit-tests-workflow";
 

// Input for the pipeline (optional context to seed into the container)
const PipelineInput = z.object({
    contextData: z.any().optional().describe("Optional context data to save to the container during docker setup"),
});

// Minimal aggregated output schema to report end-to-end results
const PipelineOutput = z.object({
    result: z.string(),
    success: z.boolean(),
    toolCallCount: z.number(),
    containerId: z.string(),
    contextPath: z.string(),
});

export const fullPipelineWorkflow = createWorkflow({
    id: "full-pipeline-workflow",
    description: "End-to-end pipeline: Docker setup → Context gather → Unit test generation",
    inputSchema: PipelineInput,
    outputSchema: PipelineOutput,
})
.then(testDockerStep)
.then(testDockerGithubCloneStep)
.then(dockerSaveContextStep)
.then(gatherStartStep as any)
.parallel([analyzeRepositoryStep as any, analyzeCodebaseStep as any, analyzeBuildDeploymentStep as any])
.then(synthesizeContextStep)
.then(gatherSaveContextStep)
.then(checkSavedPlanStep as any)
.then(loadContextAndPlanStep)
.then(generateTestCodeStep)
.then(finalizeStep)
.commit();


