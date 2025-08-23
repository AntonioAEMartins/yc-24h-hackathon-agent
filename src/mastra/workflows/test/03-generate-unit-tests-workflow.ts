import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";
import { exec } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import path from "path";
import os from "os";
import { notifyStepStatus } from "../../tools/alert-notifier";

const ALERTS_ONLY = (process.env.ALERTS_ONLY === 'true') || (process.env.LOG_MODE === 'alerts_only') || (process.env.MASTRA_LOG_MODE === 'alerts_only');

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

/**
 * Input schema for the workflow - what we start with
 */
const WorkflowInput = z.object({
    containerId: z.string().describe("Docker container ID where the repository is mounted"),
    contextPath: z.string().optional().default("/app/agent.context.json").describe("Path to the context file"),
    projectId: z.string().describe("Project ID associated with this workflow run"),
    // Optional targeting to allow per-file workflow instances
    targetTestFile: z.string().optional().describe("Specific test file path (e.g., tests/.../*.test.ts) to generate"),
    workflowId: z.string().optional().describe("Logical workflow id for alert correlation"),
    workflowInstanceId: z.string().optional().describe("Unique per-file workflow instance id for alert correlation"),
});

/**
 * Repository analysis schema for testing strategy
 */
const RepoTestAnalysis = z.object({
    sourceModules: z.array(z.object({
        modulePath: z.string().describe("Path to the module directory"),
        sourceFiles: z.array(z.string()).describe("Source files in this module"),
        priority: z.enum(["high", "medium", "low"]).describe("Priority level for testing"),
        language: z.string().describe("Programming language"),
    })).describe("List of source modules to test"),
    testingFramework: z.string().describe("Testing framework to use (e.g., jest, vitest)"),
    testDirectory: z.string().describe("Directory where tests should be placed"),
    totalFiles: z.number().describe("Total number of files to test"),
});

/**
 * Test specification schema for individual files
 */
const TestSpecification = z.object({
    sourceFile: z.string().describe("Path to the source file"),
    functions: z.array(z.object({
        name: z.string().describe("Function or method name"),
        testCases: z.array(z.string()).describe("Test cases to implement"),
    })).describe("Functions and their test cases"),
});

/**
 * Task assignment for coding agents
 */
const CodingTask = z.object({
    taskId: z.string().describe("Unique task identifier"),
    agentId: z.string().describe("Agent responsible for this task"),
    sourceFile: z.string().describe("Source file to test"),
    testFile: z.string().describe("Test file to generate"),
    testSpec: TestSpecification.describe("Test specification for this file"),
    priority: z.enum(["high", "medium", "low"]).describe("Task priority"),
    framework: z.string().describe("Testing framework to use"),
});

/**
 * Test generation result for individual files
 */
const TestFileResult = z.object({
    sourceFile: z.string().describe("Source file that was tested"),
    testFile: z.string().describe("Generated test file path"),
    functionsCount: z.number().describe("Number of functions tested"),
    testCasesCount: z.number().describe("Number of test cases generated"),
    success: z.boolean().describe("Whether generation was successful"),
    error: z.string().optional().describe("Error message if generation failed"),
});

/**
 * Comprehensive test generation result
 */
const TestGenerationResult = z.object({
    testFiles: z.array(TestFileResult).describe("Results for each test file"),
    summary: z.object({
        totalSourceFiles: z.number().describe("Total source files processed"),
        totalTestFiles: z.number().describe("Total test files generated"),
        totalFunctions: z.number().describe("Total functions tested"),
        totalTestCases: z.number().describe("Total test cases generated"),
        successfulFiles: z.number().describe("Number of successfully generated test files"),
        failedFiles: z.number().describe("Number of failed test file generations"),
    }).describe("Overall generation summary"),
    quality: z.object({
        syntaxValid: z.boolean().describe("Whether generated tests have valid syntax"),
        followsBestPractices: z.boolean().describe("Whether tests follow best practices"),
        coverageScore: z.number().describe("Estimated test coverage score (0-100)"),
    }).describe("Quality assessment of generated tests"),
});

/**
 * Final workflow output schema
 */
const UnitTestResult = z.object({
    result: z.string().describe("Human-readable result message"),
    success: z.boolean().describe("Whether the workflow completed successfully"),
    toolCallCount: z.number().describe("Total number of tool calls made"),
    testGeneration: TestGenerationResult.describe("Detailed test generation results"),
    recommendations: z.array(z.string()).describe("Recommendations for next steps"),
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Helper function to call agents with proper error handling and logging
 */
async function callAgent<T>(
    agentName: "unitTestAgent" | "testAnalysisAgent" | "testSpecificationAgent" | "testGenerationAgent" | "testValidationAgent" | "dockerAgent" | "contextAgent",
    prompt: string, 
    schema: z.ZodType<T>, 
    maxSteps: number = 1000,
    runId?: string,
    logger?: any
): Promise<T> {
    const agent = mastra?.getAgent(agentName);
    if (!agent) {
        throw new Error(`Agent '${agentName}' not found`);
    }
    
    logger?.debug(`🤖 Invoking ${agentName}`, {
        promptLength: prompt.length,
        maxSteps,
        schemaName: (schema as any)._def?.typeName || 'unknown',
        type: "AGENT_CALL",
        runId: runId,
    });

    const startTime = Date.now();
    const result: any = await agent.generate(prompt, { 
        maxSteps, 
        maxRetries: 3,
    });
    const duration = Date.now() - startTime;
    
    const text = (result?.text || "{}").toString();
    
    logger?.debug(`📤 ${agentName} response received`, {
        responseLength: text.length,
        duration: `${duration}ms`,
        type: "AGENT_RESPONSE",
        runId: runId,
    });
    
    // Extract JSON from response with improved logic
    let jsonText = text;
    
    // Try multiple extraction strategies
    // 1. Try markdown code fences (json or generic)
    const jsonMarkdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMarkdownMatch && jsonMarkdownMatch[1].trim().length > 10) {
        jsonText = jsonMarkdownMatch[1].trim();
        logger?.debug(`📋 Extracted JSON from markdown code fence`, {
            originalLength: text.length,
            extractedLength: jsonText.length,
            type: "JSON_EXTRACTION",
            runId: runId,
        });
    } 
    // 2. Try finding the largest JSON object (from first { to last })
    else {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            jsonText = text.substring(start, end + 1);
            logger?.debug(`📋 Extracted JSON from object boundaries`, {
                originalLength: text.length,
                extractedLength: jsonText.length,
                boundaries: { start, end },
                type: "JSON_EXTRACTION",
                runId: runId,
            });
        }
        // 3. Try finding JSON after common prefixes
        else {
            const patterns = [
                /(?:Here's the|Here is the|The|Result:|Output:)\s*(?:JSON|json)?\s*[:\-]?\s*(\{[\s\S]*\})/i,
                /(?:```\s*)?(\{[\s\S]*\})(?:\s*```)?/,
                /JSON:\s*(\{[\s\S]*\})/i
            ];
            
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match && match[1] && match[1].trim().length > 10) {
                    jsonText = match[1].trim();
                    logger?.debug(`📋 Extracted JSON using pattern matching`, {
                        originalLength: text.length,
                        extractedLength: jsonText.length,
                        pattern: pattern.toString(),
                        type: "JSON_EXTRACTION",
                        runId: runId,
                    });
                    break;
                }
            }
        }
    }
    
    // Validate extraction quality
    if (jsonText.length < 10 || jsonText === "..." || !jsonText.includes('{')) {
        logger?.warn(`⚠️ Poor JSON extraction quality`, {
            extractedLength: jsonText.length,
            preview: jsonText.substring(0, 100),
            type: "JSON_EXTRACTION",
            runId: runId,
        });
        throw new Error(`Failed to extract valid JSON from agent response. Preview: ${text.substring(0, 500)}...`);
    }
    
    try {
        const parsed = JSON.parse(jsonText);
        const validated = schema.parse(parsed);
        
        logger?.debug(`✅ JSON parsing and validation successful`, {
            jsonLength: jsonText.length,
            validatedKeys: typeof validated === 'object' && validated !== null ? Object.keys(validated as object).length : 0,
            type: "JSON_VALIDATION",
            runId: runId,
        });
        
        return validated;
    } catch (parseError) {
        logger?.error(`❌ JSON parsing failed, attempting recovery`, {
            parseError: parseError instanceof Error ? parseError.message : 'Unknown error',
            jsonText: jsonText.substring(0, 500),
            type: "JSON_ERROR",
            runId: runId,
        });
        
        // Recovery attempt: try to fix common JSON issues
        let recoveredJson = jsonText;
        
        // Fix trailing commas
        recoveredJson = recoveredJson.replace(/,(\s*[}\]])/g, '$1');
        
        // Fix unescaped quotes in strings (basic attempt)
        recoveredJson = recoveredJson.replace(/": "([^"]*)"([^",\}\]]*)"([^"]*)"(\s*[,\}\]])/g, '": "$1\\"$2\\"$3"$4');
        
        // Fix incomplete JSON (try to close it)
        const openBraces = (recoveredJson.match(/\{/g) || []).length;
        const closeBraces = (recoveredJson.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
            recoveredJson += '}';
        }
        
        try {
            const parsed = JSON.parse(recoveredJson);
            const validated = schema.parse(parsed);
            
            logger?.info(`✅ JSON recovery successful`, {
                originalLength: jsonText.length,
                recoveredLength: recoveredJson.length,
                type: "JSON_RECOVERY",
                runId: runId,
            });
            
            return validated;
        } catch (recoveryError) {
            logger?.error(`❌ JSON parsing and recovery both failed`, {
                originalError: parseError instanceof Error ? parseError.message : 'Unknown error',
                recoveryError: recoveryError instanceof Error ? recoveryError.message : 'Unknown error',
                fullResponse: text.substring(0, 1000),
                type: "JSON_ERROR",
                runId: runId,
            });
            
            throw new Error(`JSON parsing failed after recovery attempt. Original: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
    }
}

/**
 * Helper function to save plan results to static file for fast resume
 */
async function savePlanResults(containerId: string, planData: any, logger?: any): Promise<void> {
    const saveFilePath = `/app/unit.plan.json`;
    
    return await new Promise((resolve) => {
        let tempFilePath: string | null = null;
        try {
            const tempDir = mkdtempSync(path.join(os.tmpdir(), 'docker-plan-'));
            tempFilePath = path.join(tempDir, 'unit.plan.json');
            writeFileSync(tempFilePath, JSON.stringify(planData, null, 2), 'utf8');

            const cpCmd = `docker cp "${tempFilePath}" ${containerId}:${saveFilePath}`;
            exec(cpCmd, (cpErr, _cpOut, cpErrOut) => {
                try { if (tempFilePath) unlinkSync(tempFilePath); } catch {}
                if (cpErr) {
                    logger?.warn("⚠️ Failed to save plan results", {
                        saveFilePath,
                        error: cpErrOut || cpErr.message,
                        type: "PLAN_SAVE"
                    });
                    resolve();
                    return;
                }

                const verifyCmd = `docker exec ${containerId} bash -lc "test -f ${saveFilePath} && wc -c ${saveFilePath}"`;
                exec(verifyCmd, (vErr, vOut, vErrOut) => {
                    if (vErr) {
                        logger?.warn("⚠️ Plan file verification failed", {
                            saveFilePath,
                            error: vErrOut || vErr.message,
                            type: "PLAN_SAVE"
                        });
                    } else {
                        logger?.info("💾 Plan results saved to static file", {
                            saveFilePath,
                            containerId: containerId.substring(0, 12),
                            size: vOut.trim(),
                            type: "PLAN_SAVE"
                        });
                    }
                    resolve();
                });
            });
        } catch (error) {
            try { if (tempFilePath) unlinkSync(tempFilePath); } catch {}
            logger?.warn("⚠️ Failed to create temp plan file", {
                saveFilePath,
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "PLAN_SAVE"
            });
            resolve();
        }
    });
}

/**
 * Helper function to load saved plan results statically (no agent calls)
 */
async function loadPlanResults(containerId: string, logger?: any): Promise<any | null> {
    const saveFilePath = `/app/unit.plan.json`;
    
    try {
        // Use direct file operations for faster access
        const { exec } = await import("child_process");
        
        return new Promise((resolve) => {
            // Check if file exists and read it
            exec(`docker exec ${containerId} bash -lc "test -f ${saveFilePath} && cat ${saveFilePath} || echo 'NOT_FOUND'"`, 
                (error, stdout, stderr) => {
                    if (error || stderr || stdout.trim() === 'NOT_FOUND') {
                        logger?.debug("No saved plan found", {
                            saveFilePath,
                            type: "PLAN_LOAD"
                        });
                        resolve(null);
                        return;
                    }
                    
                    try {
                        const planData = JSON.parse(stdout.trim());
                        logger?.info("📂 Loaded saved plan results statically", {
                            saveFilePath,
                            containerId: containerId.substring(0, 12),
                            highPriorityModules: planData.repoAnalysis?.sourceModules?.filter((m: any) => m.priority === 'high')?.length || 0,
                            type: "PLAN_LOAD"
                        });
                        resolve(planData);
                    } catch (parseError) {
                        logger?.warn("Failed to parse saved plan", {
                            parseError: parseError instanceof Error ? parseError.message : 'Unknown error',
                            type: "PLAN_LOAD"
                        });
                        resolve(null);
                    }
                }
            );
        });
    } catch (error) {
        logger?.debug("Error loading plan results", {
            error: error instanceof Error ? error.message : 'Unknown error',
            type: "PLAN_LOAD"
        });
        return null;
    }
}

// ============================================================================
// WORKFLOW STEPS
// ============================================================================

/**
 * Step 0: Check for Saved Plan (Fast Resume Functionality)
 * 
 * This step quickly checks for a previously saved plan file statically
 * without agent calls for maximum speed. If found, skips to test generation.
 */
export const checkSavedPlanStep = createStep({
    id: "check-saved-plan-step",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis.optional(),
        testSpecs: z.array(TestSpecification).optional(),
        skipToGeneration: z.boolean(),
        projectId: z.string(),
        targetTestFile: z.string().optional(),
        workflowId: z.string().optional(),
        workflowInstanceId: z.string().optional(),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, contextPath } = inputData;
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        await notifyStepStatus({
            stepId: "check-saved-plan-step",
            status: "starting",
            runId,
            containerId,
            title: "Check saved plan",
            subtitle: "Looking for cached plan results",
            projectId: inputData.projectId,
            workflowId: inputData.workflowId,
            workflowInstanceId: inputData.workflowInstanceId,
        });
        
        logger?.info("⚡ Step 0/3: Fast check for saved plan", {
            step: "0/3",
            stepName: "Check Saved Plan",
            containerId: containerId.substring(0, 12),
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        // Try to load saved plan statically (no agent calls)
        const savedPlan = await loadPlanResults(containerId, logger);
        
        if (savedPlan && savedPlan.repoAnalysis && savedPlan.testSpecs) {
            // Optionally narrow to a single target test file if provided
            let narrowedSpecs = savedPlan.testSpecs;
            if (inputData.targetTestFile) {
                const testDir = savedPlan.repoAnalysis.testDirectory || 'tests';
                narrowedSpecs = (savedPlan.testSpecs || []).filter((spec: any) => {
                    const computed = (spec.sourceFile || '')
                        .replace(/^src\//, `${testDir}/`)
                        .replace(/\.ts$/, '.test.ts');
                    return computed === inputData.targetTestFile;
                });
                if (narrowedSpecs.length === 0) narrowedSpecs = savedPlan.testSpecs;
            }
            const highPriorityModules = savedPlan.repoAnalysis.sourceModules?.filter((m: any) => m.priority === 'high') || [];
            
            logger?.info("✅ Step 0/3: Found saved plan, skipping to test generation", {
                step: "0/3", 
                highPriorityModules: highPriorityModules.length,
                testSpecs: narrowedSpecs?.length || 0,
                testingFramework: savedPlan.repoAnalysis.testingFramework,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "check-saved-plan-step",
                status: "completed",
                runId,
                containerId,
                title: "Saved plan found",
                subtitle: "Skipping planning",
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });

            return {
                containerId,
                contextPath,
                repoAnalysis: savedPlan.repoAnalysis,
                testSpecs: narrowedSpecs,
                skipToGeneration: true,
                projectId: inputData.projectId,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };
        } else {
            logger?.info("📋 Step 0/3: No saved plan found, proceeding with planning", {
                step: "0/3",
                type: "WORKFLOW_STEP", 
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "check-saved-plan-step",
                status: "completed",
                runId,
                containerId,
                title: "No saved plan",
                subtitle: "Proceeding to plan",
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });

            return {
                containerId,
                contextPath,
                skipToGeneration: false,
                projectId: inputData.projectId,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };
        }
    },
});

/**
 * Step 1: Load Context and Plan Testing Strategy (MVP - High Priority Only)
 * 
 * This step loads the repository context and creates a focused testing strategy
 * for ONE high priority module only. Results are saved to static file for fast resume.
 */
export const loadContextAndPlanStep = createStep({
    id: "load-context-and-plan-step",
    inputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis.optional(),
        testSpecs: z.array(TestSpecification).optional(),
        skipToGeneration: z.boolean(),
        projectId: z.string(),
        targetTestFile: z.string().optional(),
        workflowId: z.string().optional(),
        workflowInstanceId: z.string().optional(),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis,
        testSpecs: z.array(TestSpecification),
        projectId: z.string(),
        targetTestFile: z.string().optional(),
        workflowId: z.string().optional(),
        workflowInstanceId: z.string().optional(),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, contextPath, repoAnalysis, testSpecs, skipToGeneration } = inputData;
        
        // If we have saved plan, skip this step
        if (skipToGeneration && repoAnalysis && testSpecs) {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
            logger?.info("⏭️ Step 1/3: Skipping planning (using saved plan)", {
                step: "1/3",
                stepName: "Load Context & Plan (Skipped)",
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "load-context-and-plan-step",
                status: "completed",
                runId,
                containerId,
                title: "Load context & plan completed",
                subtitle: "Skipped - using saved plan",
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });
            
            return {
                containerId,
                contextPath,
                repoAnalysis,
                testSpecs,
                projectId: inputData.projectId,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };
        }
        await notifyStepStatus({
            stepId: "load-context-and-plan-step",
            status: "starting",
            runId,
            containerId,
            title: "Load context & plan",
            subtitle: "Creating MVP plan for tests",
            projectId: inputData.projectId,
            workflowId: inputData.workflowId,
            workflowInstanceId: inputData.workflowInstanceId,
        });

        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        
        logger?.info("📋 Step 1/3: Loading context and planning high-priority testing strategy", {
            step: "1/3",
            stepName: "Load Context & Plan (MVP)",
            containerId,
            contextPath,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

                const prompt = `CRITICAL: Return ONLY valid JSON. No explanations, no comments.

TASK: Intelligent context analysis and high-priority module testing strategy using docker_exec with containerId='${containerId}'.

🔍 CONTEXT ANALYSIS WORKFLOW:

PHASE 1: REPOSITORY DISCOVERY
1. Find project directory: docker_exec ls -la /app/ | grep "^d" | grep -v "\\." | awk '{print $NF}' | head -1
2. Read comprehensive context: docker_exec cat ${contextPath}
3. Parse repository structure, frameworks, and dependencies
4. Identify source code patterns and architecture

PHASE 2: INTELLIGENT MODULE PRIORITIZATION
5. Analyze source directories and scan for modules: docker_exec find /app/PROJECT_DIR/src -name "*.ts" -type f | head -20
6. Evaluate module complexity and testability based on:
   - Core business logic vs utilities
   - External dependency count
   - Function complexity and async patterns
   - Error handling requirements
   - Integration points with other modules
7. Select the SINGLE highest value module for MVP testing

PHASE 3: COMPREHENSIVE TEST SPECIFICATION
8. Deep-analyze the selected module: docker_exec cat /app/PROJECT_DIR/[SELECTED_SOURCE_FILE]
9. Extract all exportable functions, classes, and methods
10. Design comprehensive test scenarios for each function:
    - Success paths with various input combinations
    - Error conditions and edge cases
    - Async/Promise handling patterns
    - Mock integration requirements
    - Performance and boundary testing
11. Create detailed test case specifications with clear expectations

🎯 STRATEGIC SELECTION CRITERIA:
- Choose modules with high business value and testability
- Prioritize core functionality over utilities
- Consider modules with complex logic that benefit most from testing
- Select files with multiple functions and varied scenarios
- Prefer modules with external dependencies for comprehensive mocking

🏗️ TESTING ARCHITECTURE REQUIREMENTS:
- Use vitest framework with TypeScript support
- Implement separate test directory structure (tests/ parallel to src/)
- Design for co-located testing patterns when beneficial
- Plan for comprehensive mocking strategies
- Structure for maintainable and scalable test suites

RETURN FORMAT (JSON only - comprehensive analysis):
{
  "repoAnalysis": {
    "sourceModules": [
      {
        "modulePath": "[ANALYZED_MODULE_PATH]",
        "sourceFiles": ["[SELECTED_HIGH_VALUE_FILE]"],
        "priority": "high",
        "language": "typescript",
        "complexity": "medium|high",
        "testability": "excellent|good",
        "businessValue": "core|important|utility",
        "dependencyCount": [NUMBER_OF_EXTERNAL_DEPS]
      }
    ],
    "testingFramework": "vitest",
    "testDirectory": "tests",
    "totalFiles": 1,
    "selectionReason": "[WHY_THIS_MODULE_WAS_CHOSEN]"
  },
  "testSpecs": [
    {
      "sourceFile": "[FULL_SOURCE_FILE_PATH]",
      "functions": [
        {
          "name": "[FUNCTION_NAME]",
          "testCases": [
            "should [expected_behavior] when [success_condition]",
            "should [error_behavior] when [error_condition]",
            "should [edge_case_behavior] when [boundary_condition]",
            "should [async_behavior] when [promise_condition]",
            "should [validation_behavior] when [input_validation_needed]"
          ],
          "mockRequirements": ["[EXTERNAL_DEPENDENCY_1]", "[EXTERNAL_DEPENDENCY_2]"],
          "complexity": "simple|medium|complex",
          "isAsync": true|false
        }
      ],
      "overallComplexity": "simple|medium|complex",
      "estimatedTestCount": [REALISTIC_TEST_COUNT]
    }
  ]
}`;

        try {
            const result = await callAgent("unitTestAgent", prompt, z.object({
                repoAnalysis: RepoTestAnalysis,
                testSpecs: z.array(TestSpecification),
            }), 1000, runId, logger);
            
            // Filter to ensure only high priority modules
            const highPriorityModules = result.repoAnalysis.sourceModules.filter(m => m.priority === 'high');
            if (highPriorityModules.length === 0) {
                // Make the first module high priority if none found
                if (result.repoAnalysis.sourceModules.length > 0) {
                    result.repoAnalysis.sourceModules[0].priority = 'high';
                    highPriorityModules.push(result.repoAnalysis.sourceModules[0]);
                }
            }
            
            // Keep only the first high priority module for MVP
            const mvpAnalysis = {
                ...result.repoAnalysis,
                sourceModules: [highPriorityModules[0]],
                totalFiles: 1,
            };
            
            // Filter test specs to match the selected module
            const mvpTestSpecs = result.testSpecs.filter(spec => 
                highPriorityModules[0].sourceFiles.some(file => 
                    spec.sourceFile.includes(file.replace('.ts', '').replace('.js', ''))
                )
            );
            
            logger?.info("✅ Step 1/3: MVP plan created for high priority module", {
                step: "1/3",
                selectedModule: highPriorityModules[0].modulePath,
                sourceFiles: highPriorityModules[0].sourceFiles,
                testSpecs: mvpTestSpecs.length,
                testingFramework: mvpAnalysis.testingFramework,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            // Save plan results to static file for fast resume
            const planData = {
                repoAnalysis: mvpAnalysis,
                testSpecs: mvpTestSpecs,
                timestamp: new Date().toISOString(),
                version: "mvp-1.0"
            };
            await savePlanResults(containerId, planData, logger);

            await notifyStepStatus({
                stepId: "load-context-and-plan-step",
                status: "completed",
                runId,
                containerId,
                title: "Load context & plan completed",
                subtitle: `MVP plan created for ${highPriorityModules[0].modulePath}`,
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });

            // Apply targetTestFile narrowing if provided
            let narrowedSpecs = mvpTestSpecs;
            if (inputData.targetTestFile) {
                const testDir = mvpAnalysis.testDirectory || 'tests';
                narrowedSpecs = mvpTestSpecs.filter((spec) => {
                    const computed = spec.sourceFile
                        .replace(/^src\//, `${testDir}/`)
                        .replace(/\.ts$/, '.test.ts');
                    return computed === inputData.targetTestFile;
                });
                if (narrowedSpecs.length === 0) narrowedSpecs = mvpTestSpecs;
            }

            return {
                containerId,
                contextPath,
                repoAnalysis: mvpAnalysis,
                testSpecs: narrowedSpecs,
                projectId: inputData.projectId,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };
        } catch (error) {
            logger?.error("❌ Step 1/3: Planning failed", {
                step: "1/3",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            logger?.warn("🔄 Using fallback MVP plan", {
                step: "1/3",
                action: "fallback",
                type: "WORKFLOW_STEP",
                runId: runId,
            });

                        // Return comprehensive fallback plan for MVP
            const fallbackAnalysis = {
                    sourceModules: [{
                    modulePath: "src/mastra/tools",
                    sourceFiles: ["cli-tool.ts"],
                    priority: "high" as const,
                        language: "typescript",
                        complexity: "medium" as const,
                        testability: "excellent" as const,
                        businessValue: "core" as const,
                        dependencyCount: 2,
                    }],
                testingFramework: "vitest",
                testDirectory: "tests",
                    totalFiles: 1,
                    selectionReason: "CLI tool selected as fallback - core utility with external dependencies suitable for comprehensive testing",
            };
            
            const fallbackTestSpecs = [{
                sourceFile: "src/mastra/tools/cli-tool.ts",
                functions: [{
                    name: "cliTool.execute",
                    testCases: [
                        "should execute command successfully with valid parameters",
                        "should reject with proper error when execution fails",
                        "should validate input parameters and throw on invalid input",
                        "should handle timeout scenarios appropriately",
                        "should increment metrics on successful calls",
                        "should handle stderr output correctly"
                    ],
                    mockRequirements: ["child_process", "@mastra/core"],
                    complexity: "medium" as const,
                    isAsync: true,
                }],
                overallComplexity: "medium" as const,
                estimatedTestCount: 6,
            }];

            await notifyStepStatus({
                stepId: "load-context-and-plan-step",
                status: "failed",
                runId,
                containerId,
                title: "Planning failed",
                subtitle: error instanceof Error ? error.message : 'Unknown error',
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });

            // Send completed status for fallback plan
            await notifyStepStatus({
                stepId: "load-context-and-plan-step",
                status: "completed",
                runId,
                containerId,
                title: "Load context & plan completed",
                subtitle: "Using fallback MVP plan",
                level: 'warning',
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });

            return {
                containerId,
                contextPath,
                repoAnalysis: fallbackAnalysis,
                testSpecs: fallbackTestSpecs,
                projectId: inputData.projectId,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };
        }
    },
});

/**
 * Helper function to retry test generation with error feedback
 */
async function retryTestGeneration(
    containerId: string,
    repoAnalysis: z.infer<typeof RepoTestAnalysis>,
    testSpecs: z.infer<typeof TestSpecification>[],
    retryCount: number,
    errorFeedback: string | undefined,
    mastra: any,
    projectId: string,
    contextPath: string | undefined,
    runId?: string,
    logger?: any
): Promise<z.infer<typeof UnitTestResult> & { projectId: string; containerId: string; contextPath?: string }> {
    if (testSpecs.length === 0) {
        throw new Error("Cannot retry test generation without test specifications");
    }

    logger?.info("🔄 Initiating test generation retry with error feedback", {
        retryCount,
        hasErrorFeedback: !!errorFeedback,
        type: "RETRY_GENERATION",
        runId: runId,
    });

    const testSpec = testSpecs[0];
    const sourceFile = testSpec.sourceFile;
    const testFile = sourceFile
        .replace(/^src\//, `${repoAnalysis.testDirectory}/`)
        .replace(/\.ts$/, '.test.ts');

    const retryPrompt = `CRITICAL: Return ONLY valid JSON. No explanations, no comments.

TASK: RETRY test generation with error feedback and corrections using docker_exec with containerId='${containerId}'.

🚨 RETRY ATTEMPT ${retryCount} 🚨

PREVIOUS ERROR FEEDBACK:
${errorFeedback || 'No specific error feedback available'}

SOURCE FILE: ${sourceFile}
TEST FILE: ${testFile}
FRAMEWORK: ${repoAnalysis.testingFramework}

🔧 ERROR-DRIVEN CORRECTION WORKFLOW:

PHASE 1: ERROR ANALYSIS & DISCOVERY
1. Find project directory: docker_exec ls -la /app/ | grep "^d" | grep -v "\\." | awk '{print $NF}' | head -1
2. Read source file thoroughly: docker_exec cat /app/PROJECT_DIR/${sourceFile}
3. Check existing test file (if any): docker_exec cat /app/PROJECT_DIR/${testFile} 2>/dev/null || echo "NO_EXISTING_TEST"
4. Analyze the specific error patterns from feedback
5. Identify root causes (syntax, imports, mocking, types, etc.)

PHASE 2: TARGETED ERROR CORRECTION
6. Based on error feedback, apply specific fixes:
   - If syntax errors: Fix TypeScript compilation issues
   - If import errors: Correct import paths and module references
   - If mocking errors: Fix vi.mock configurations and typing
   - If execution errors: Fix async/await patterns and assertions
   - If dependency errors: Ensure proper external dependency handling

PHASE 3: ENHANCED TEST GENERATION
7. Ensure directory exists using file tool: file_operations create_dir with filePath "/app/PROJECT_DIR/$(dirname ${testFile})"
8. Generate CORRECTED test file addressing all error feedback using file tool:

MANDATORY ERROR-CORRECTED PATTERNS:
- Fix ALL syntax issues identified in error feedback
- Correct import statements based on actual source analysis
- Fix mocking configurations with proper vi.mock syntax
- Ensure proper TypeScript typing throughout
- Fix async/await patterns if Promise-related errors occurred
- Correct assertion patterns and test structure
- Address any framework-specific issues

TEST SPECIFICATION (implement with error corrections):
${JSON.stringify(testSpec, null, 2)}

9. Persist test file using file tool:
   - Use file_operations write with filePath "/app/PROJECT_DIR/${testFile}" and content set to the full corrected test code exactly

PHASE 4: VERIFICATION WITH ERROR PREVENTION
10. Verify file creation: docker_exec ls -la /app/PROJECT_DIR/${testFile}
11. Quick syntax check: docker_exec head -30 /app/PROJECT_DIR/${testFile}
12. Verify corrections address the reported errors
13. Confirm line count shows substantial content: docker_exec wc -l /app/PROJECT_DIR/${testFile}

🎯 RETRY-SPECIFIC REQUIREMENTS:
- MUST directly address each error mentioned in feedback
- MUST improve upon the previous attempt substantially
- MUST ensure syntax validity and proper imports
- MUST fix any mocking or dependency issues from feedback
- MUST generate executable, working test code
- MUST include comprehensive error handling
- Generate AT LEAST 5+ test cases per function (more if errors indicated coverage issues)

🚨 ABSOLUTE REQUIREMENTS 🚨
- MUST use the exact test file path: ${testFile}
- MUST create INSIDE the project directory
- MUST analyze and fix ALL errors from feedback
- MUST actually write corrected content to disk
- MUST verify the file exists and has substantial content
- Tests must be sophisticated, corrected, and executable
- THE FILE MUST BE PHYSICALLY SAVED, READABLE, AND ERROR-FREE

RETURN FORMAT (JSON only - MUST return accurate counts after corrections):
{
  "sourceFile": "${sourceFile}",
  "testFile": "${testFile}",
  "functionsCount": [ACTUAL_FUNCTION_COUNT],
  "testCasesCount": [ACTUAL_TEST_CASES_COUNT],
  "success": true,
  "correctionsMade": "[SUMMARY_OF_CORRECTIONS_APPLIED]"
}`;

    try {
        const retryResult = await callAgent("unitTestAgent", retryPrompt, z.object({
            sourceFile: z.string(),
            testFile: z.string(),
            functionsCount: z.number(),
            testCasesCount: z.number(),
            success: z.boolean(),
            error: z.string().optional(),
            correctionsMade: z.string().optional(),
        }), 700, runId, logger); // More steps for retry with corrections

        logger?.info("✅ Retry test generation completed", {
            retryCount,
            success: retryResult.success,
            testFile: retryResult.testFile,
            functionsCount: retryResult.functionsCount,
            testCasesCount: retryResult.testCasesCount,
            correctionsMade: retryResult.correctionsMade?.substring(0, 100),
            type: "RETRY_GENERATION",
            runId: runId,
        });

        // Create test generation result for retry
        const retryTestGeneration: z.infer<typeof TestGenerationResult> = {
            testFiles: [retryResult],
            summary: {
                totalSourceFiles: 1,
                totalTestFiles: retryResult.success ? 1 : 0,
                totalFunctions: retryResult.functionsCount,
                totalTestCases: retryResult.testCasesCount,
                successfulFiles: retryResult.success ? 1 : 0,
                failedFiles: retryResult.success ? 0 : 1,
            },
            quality: {
                syntaxValid: retryResult.success,
                followsBestPractices: retryResult.success,
                coverageScore: retryResult.success ? 80 : 0,
            },
        };

        // Return the retry test generation result (let finalize step handle final processing)
        return {
            result: retryResult.success 
                ? `✅ Test generation retry ${retryCount} successful: ${retryResult.testFile} created`
                : `❌ Test generation retry ${retryCount} failed`,
            success: retryResult.success,
            toolCallCount: cliToolMetrics.callCount,
            testGeneration: retryTestGeneration,
            recommendations: [
                `Retry attempt ${retryCount} completed with ${retryResult.success ? 'success' : 'failure'}`,
                ...(retryResult.correctionsMade ? [`Corrections applied: ${retryResult.correctionsMade}`] : []),
                "Review error feedback and consider manual intervention if retries continue to fail"
            ],
            projectId: projectId,
            containerId,
            contextPath,
        };

    } catch (error) {
        logger?.error("❌ Retry test generation failed", {
            retryCount,
            error: error instanceof Error ? error.message : 'Unknown error',
            type: "RETRY_GENERATION",
            runId: runId,
        });

        // Return failed result for retry
        const failedRetryResult = {
            sourceFile,
            testFile,
            functionsCount: 0,
            testCasesCount: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };

        const failedTestGeneration: z.infer<typeof TestGenerationResult> = {
            testFiles: [failedRetryResult],
            summary: {
                totalSourceFiles: 1,
                totalTestFiles: 0,
                totalFunctions: 0,
                totalTestCases: 0,
                successfulFiles: 0,
                failedFiles: 1,
            },
            quality: {
                syntaxValid: false,
                followsBestPractices: false,
                coverageScore: 0,
            },
        };

        // Return failed retry result (let finalize step handle final processing)
        return {
            result: `❌ Test generation retry ${retryCount} failed with error`,
            success: false,
            toolCallCount: cliToolMetrics.callCount,
            testGeneration: failedTestGeneration,
            recommendations: [
                `Retry attempt ${retryCount} failed with error: ${failedRetryResult.error}`,
                "Review error patterns and consider manual test creation",
                "Check Docker container and dependency availability"
            ],
            projectId: projectId,
            containerId,
            contextPath,
        };
    }
}

/**
 * Helper function to save checkpoint results during block generation
 */
async function saveCheckpoint(containerId: string, blockId: string, results: any, logger?: any): Promise<void> {
    const checkpointFile = `/app/checkpoint-${blockId}.json`;
    
    try {
        const prompt = `Save checkpoint results using docker_exec with containerId='${containerId}'.

TASK: Save checkpoint data for block ${blockId}.

Instructions:
1. Create checkpoint file: echo '${JSON.stringify(results).replace(/'/g, "'\\''")}' > ${checkpointFile}
2. Verify file was created: ls -la ${checkpointFile}`;

        await callAgent("unitTestAgent", prompt, z.object({
            success: z.boolean(),
            message: z.string(),
        }), 50, undefined, logger);
        
        logger?.info(`💾 Checkpoint saved for block ${blockId}`, {
            checkpointFile,
            blockId,
            type: "CHECKPOINT_SAVE"
        });
    } catch (error) {
        logger?.warn(`⚠️ Failed to save checkpoint for block ${blockId}`, {
            error: error instanceof Error ? error.message : 'Unknown error',
            type: "CHECKPOINT_SAVE"
        });
    }
}

// Removed complex manager-worker step (was commented-out) to prevent nested comment issues.

/**
 * Step 2: Simple Test Generation (MVP Validation)
 * 
 * Basic step that generates a simple test file using unitTestAgent with minimal reasoning
 * to validate that the workflow works before implementing complex features.
 */
export const generateTestCodeStep = createStep({
    id: "generate-test-code-step",
    inputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis,
        testSpecs: z.array(TestSpecification),
        projectId: z.string(),
        targetTestFile: z.string().optional(),
        workflowId: z.string().optional(),
        workflowInstanceId: z.string().optional(),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string().optional(),
        testGeneration: TestGenerationResult,
        repoAnalysis: RepoTestAnalysis,
        testSpecs: z.array(TestSpecification),
        projectId: z.string(),
        targetTestFile: z.string().optional(),
        workflowId: z.string().optional(),
        workflowInstanceId: z.string().optional(),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, repoAnalysis, testSpecs } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🧪 Step 2/3: Simple test generation (MVP validation)", {
            step: "2/3",
            stepName: "Simple Test Generation",
            sourceFile: testSpecs[0]?.sourceFile || "unknown",
            framework: repoAnalysis.testingFramework,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        const testSpec = testSpecs[0];
        if (!testSpec) {
            throw new Error("No test specification available");
        }

        const sourceFile = testSpec.sourceFile;
        // Convert src/... to tests/...; allow override via targetTestFile
        const computedTestFile = sourceFile
            .replace(/^src\//, `${repoAnalysis.testDirectory}/`)
            .replace(/\.ts$/, '.test.ts');
        const testFile = inputData.targetTestFile || computedTestFile;

        const prompt = `CRITICAL: Return ONLY valid JSON. No explanations, no comments.

TASK: Generate high-quality vitest test file with nano-level reasoning using docker_exec with containerId='${containerId}'.

SOURCE FILE: ${sourceFile}
TEST FILE: ${testFile}
FRAMEWORK: ${repoAnalysis.testingFramework}

🚨 ABSOLUTE CRITICAL PATH REQUIREMENTS 🚨
- Find the project directory inside /app/ (should be the only subdirectory)
- The test file MUST be created INSIDE the project directory
- DO NOT create it at: /app/${sourceFile.replace('.ts', '.test.ts')}
- DO NOT create it at: /app/tests/ (wrong location - must be inside project)
- MUST be inside the project directory at: PROJECT_DIR/${testFile}

TEST SPECIFICATION (analyze thoroughly):
${JSON.stringify(testSpec, null, 2)}

🧠 NANO-LEVEL REASONING WORKFLOW:

PHASE 1: DISCOVERY & ANALYSIS
1. Find project directory: docker_exec ls -la /app/ | grep "^d" | grep -v "\\." | awk '{print $NF}' | head -1
2. Set PROJECT_DIR variable based on step 1 result
3. Read and analyze source file: docker_exec cat /app/PROJECT_DIR/${sourceFile}
4. Identify imports, exports, functions, classes, and dependencies
5. Analyze function signatures, parameters, return types, and error conditions
6. Determine external dependencies that need mocking
7. Identify async/sync patterns and Promise handling needs

PHASE 2: INTELLIGENT TEST DESIGN
8. Map each function to comprehensive test scenarios:
   - Happy path with valid inputs
   - Edge cases with boundary values
   - Error conditions and exception handling
   - Async/Promise resolution and rejection flows
   - Mock integration and dependency injection
9. Design mock strategies for external dependencies (fs, child_process, @mastra/core, etc.)
10. Plan test structure with proper setup/teardown
11. Determine assertion strategies and coverage goals

PHASE 3: SOPHISTICATED CODE GENERATION
12. Ensure directory exists: file_operations create_dir with filePath "/app/PROJECT_DIR/$(dirname ${testFile})"
13. Generate comprehensive test file with advanced patterns:

REQUIRED TEST PATTERNS:
- Proper vitest imports (vi, expect, describe, it, beforeEach, afterEach, beforeAll, afterAll)
- Smart mocking of ALL external dependencies with proper typing
- Comprehensive test cases covering ALL functions from specification
- Error boundary testing with proper error assertions
- Async/await testing patterns with proper Promise handling
- Mock setup/reset in beforeEach/afterEach hooks
- Descriptive test names following "should [expected behavior] when [condition]" pattern
- Proper TypeScript typing and interface mocking
- Integration test considerations where applicable
- Performance and edge case coverage

EXAMPLE SOPHISTICATED STRUCTURE:
\`\`\`typescript
import { vi, expect, describe, it, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// Import source modules and types
import { [ACTUAL_IMPORTS_FROM_SOURCE] } from '[ACTUAL_IMPORT_PATH]';

// Mock external dependencies
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('@mastra/core', () => ({
  // Mock actual exports based on source analysis
}));

describe('[MODULE_NAME]', () => {
  // Proper mock typing
  const mockExec = vi.mocked(require('child_process').exec);
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('[FUNCTION_NAME]', () => {
    it('should handle successful execution with valid parameters', async () => {
      // Comprehensive positive test case
    });
    
    it('should reject with proper error when execution fails', async () => {
      // Error condition testing
    });
    
    it('should validate input parameters and throw on invalid input', () => {
      // Input validation testing
    });
    
    // Additional test cases based on function complexity
  });
});
\`\`\`

14. Write sophisticated test file using file tool:
   - Use file_operations write with filePath "/app/PROJECT_DIR/${testFile}" and content set to the full generated test code exactly

PHASE 4: VERIFICATION & QUALITY ASSURANCE
15. Verify file creation: docker_exec ls -la /app/PROJECT_DIR/${testFile}
16. Verify file content: docker_exec cat /app/PROJECT_DIR/${testFile}
17. Check syntax validity: docker_exec head -50 /app/PROJECT_DIR/${testFile}
18. Confirm line count and complexity: docker_exec wc -l /app/PROJECT_DIR/${testFile}
19. Validate test structure meets quality standards

🎯 QUALITY REQUIREMENTS:
- ALL functions from specification must have comprehensive tests
- Mock ALL external dependencies with proper typing
- Include positive, negative, and edge case scenarios
- Use proper async/await patterns where needed
- Follow vitest best practices and TypeScript standards
- Generate AT LEAST 5+ test cases per function
- Include proper error handling and validation tests
- Use descriptive test names and organize with nested describe blocks
- Ensure tests are actually executable and syntactically correct
- Include performance considerations for complex operations

🚨 ABSOLUTE REQUIREMENTS 🚨
- MUST use the exact test file path: ${testFile}
- MUST create INSIDE the project directory (NOT at /app/ root level)
- MUST dynamically find the project directory first
- MUST actually write the sophisticated test content to disk
- MUST verify the file exists and has substantial content
- MUST analyze source file thoroughly before generating tests
- MUST include ALL functions and scenarios from specification
- THE FILE MUST BE PHYSICALLY SAVED, READABLE, AND EXECUTABLE
- Tests must be sophisticated, not placeholder stub tests

RETURN FORMAT (JSON only - MUST return accurate counts):
{
  "sourceFile": "${sourceFile}",
  "testFile": "${testFile}",
  "functionsCount": [ACTUAL_FUNCTION_COUNT],
  "testCasesCount": [ACTUAL_TEST_CASES_COUNT], 
  "success": true
}`;

        try {
            const result = await callAgent("unitTestAgent", prompt, z.object({
                sourceFile: z.string(),
                testFile: z.string(),
                functionsCount: z.number(),
                testCasesCount: z.number(),
                success: z.boolean(),
                error: z.string().optional(),
            }), 500, runId, logger); // Reduced max steps for simplicity

            // Validate that the agent used the correct test file path
            if (result.testFile !== testFile) {
                logger?.error("❌ Agent used wrong test file path", {
                    expected: testFile,
                    actual: result.testFile,
                    type: "VALIDATION_ERROR",
                runId: runId,
            });
                throw new Error(`Agent created test file at wrong path. Expected: ${testFile}, Got: ${result.testFile}`);
            }

            // The agent instructions now include verification steps, so we rely on those
            logger?.info("✅ Test file creation delegated to agent with explicit verification", {
                testFile: testFile,
                type: "DELEGATION_INFO",
                runId: runId,
            });

            logger?.info("✅ Step 2/3: Simple test generation completed", {
                step: "2/3",
                testFile: result.testFile,
                success: result.success,
                functionsCount: result.functionsCount,
                testCasesCount: result.testCasesCount,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "generate-test-code-step",
                status: "completed",
                runId,
                containerId,
                title: "Test generation completed",
                subtitle: result.testFile,
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });

            // Create simple test generation result
            const testGeneration: z.infer<typeof TestGenerationResult> = {
                testFiles: [result],
                summary: {
                    totalSourceFiles: 1,
                    totalTestFiles: result.success ? 1 : 0,
                    totalFunctions: result.functionsCount,
                    totalTestCases: result.testCasesCount,
                    successfulFiles: result.success ? 1 : 0,
                    failedFiles: result.success ? 0 : 1,
                },
                quality: {
                    syntaxValid: result.success,
                    followsBestPractices: result.success,
                    coverageScore: result.success ? 75 : 0,
                },
            };

            return {
                containerId,
                contextPath: inputData.contextPath,
                testGeneration,
                repoAnalysis,
                testSpecs: [testSpec],
                projectId: inputData.projectId,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };
        } catch (error) {
            logger?.error("❌ Step 2/3: Simple test generation failed", {
                step: "2/3",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "generate-test-code-step",
                status: "failed",
                runId,
                containerId,
                title: "Test generation failed",
                subtitle: error instanceof Error ? error.message : 'Unknown error',
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });

            // Return failed result
            const failedResult = {
                sourceFile,
                testFile,
                functionsCount: 0,
                testCasesCount: 0,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };

            const testGeneration: z.infer<typeof TestGenerationResult> = {
                testFiles: [failedResult],
                summary: {
                    totalSourceFiles: 1,
                    totalTestFiles: 0,
                    totalFunctions: 0,
                    totalTestCases: 0,
                    successfulFiles: 0,
                    failedFiles: 1,
                },
                quality: {
                    syntaxValid: false,
                    followsBestPractices: false,
                    coverageScore: 0,
                },
            };

            return {
                containerId,
                contextPath: inputData.contextPath,
                testGeneration,
                repoAnalysis,
                testSpecs: [testSpec],
                projectId: inputData.projectId,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };
        }
    },
});

/**
 * Helper function to ensure completion notification is always sent
 */
async function ensureCompletionNotification(
    stepId: string,
    status: "completed" | "failed",
    runId: string | undefined,
    containerId: string,
    projectId: string,
    success: boolean,
    subtitle?: string,
    error?: string,
    workflowId?: string,
    workflowInstanceId?: string
): Promise<void> {
    try {
        await notifyStepStatus({
            stepId,
            status,
            runId,
            containerId,
            title: status === "completed" ? "Finalize completed" : "Finalize failed",
            subtitle: subtitle || (success ? "Success" : "Completed with warnings"),
            level: error ? 'error' : (success ? 'success' : 'warning'),
            toolCallCount: cliToolMetrics.callCount,
            projectId,
            workflowId,
            workflowInstanceId,
        });
    } catch (notificationError) {
        // Log the notification failure but don't throw to avoid masking the original result
        console.warn('⚠️ Failed to send completion notification:', notificationError);
    }
}

/**
 * Step 3: Finalize with Syntax Validation and Retry Logic (Enhanced MVP)
 * 
 * Advanced final step that validates test syntax, executes tests, and retries with error feedback if needed.
 * Improved with comprehensive error handling and guaranteed completion notifications.
 */
export const finalizeStep = createStep({
    id: "finalize-step",
    inputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string().optional(),
        testGeneration: TestGenerationResult,
        repoAnalysis: RepoTestAnalysis,
        testSpecs: z.array(TestSpecification),
        projectId: z.string(),
        retryCount: z.number().optional().default(0),
        lastError: z.string().optional(),
        targetTestFile: z.string().optional(),
        workflowId: z.string().optional(),
        workflowInstanceId: z.string().optional(),
    }),
    outputSchema: UnitTestResult.extend({
        projectId: z.string(),
        containerId: z.string(),
        contextPath: z.string().optional(),
        targetTestFile: z.string().optional(),
        workflowId: z.string().optional(),
        workflowInstanceId: z.string().optional(),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { testGeneration, containerId, repoAnalysis, testSpecs, retryCount = 0, lastError } = inputData;
        const logger = mastra?.getLogger();
        const maxRetries = 2;
        
        // Track execution state for proper cleanup
        let executionResult: any = null;
        let executionError: Error | null = null;
        let isRetryPath = false;
        try {
            // Send starting notification
            await notifyStepStatus({
                stepId: "finalize-step",
                status: "starting",
                runId,
                containerId,
                title: "Finalize",
                subtitle: "Validation and recommendations",
                projectId: inputData.projectId,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            });
            
            logger?.info("🔍 Step 3/3: Enhanced finalization with syntax validation and retry logic", {
                step: "3/3",
                stepName: "Enhanced Finalize with Validation",
                testFileGenerated: testGeneration.testFiles.length,
                retryCount,
                maxRetries,
                hasLastError: !!lastError,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            // Check if we should retry due to previous failures
            if (testGeneration.summary.failedFiles > 0 && retryCount < maxRetries && repoAnalysis && testSpecs) {
                logger?.warn("⚠️ Test generation had failures, initiating retry with error feedback", {
                    step: "3/3",
                    failedFiles: testGeneration.summary.failedFiles,
                    retryCount: retryCount + 1,
                    lastError: lastError?.substring(0, 200),
                    type: "WORKFLOW_STEP",
                    runId: runId,
                });

                isRetryPath = true;
                
                // Execute retry with error feedback - store result, don't return yet
                executionResult = await retryTestGeneration(
                    containerId,
                    repoAnalysis,
                    testSpecs,
                    retryCount + 1,
                    lastError,
                    mastra,
                    inputData.projectId,
                    inputData.contextPath,
                    runId,
                    logger
                );

                // Don't return here - let finally block handle notification
                return executionResult;
            }

            // Main execution path: Create a copy to avoid mutating the input
            const processedTestGeneration = { 
                ...testGeneration,
                quality: { ...testGeneration.quality }
            };

            // Phase 1: Syntax and Execution Validation
            if (processedTestGeneration.summary.successfulFiles > 0) {
                const testFile = processedTestGeneration.testFiles[0];
                
                logger?.info("✅ Phase 1: Syntax and execution validation", {
                    step: "3/3",
                    phase: "validation",
                    testFile: testFile?.testFile,
                    type: "WORKFLOW_STEP",
                    runId: runId,
                });

                const validationPrompt = `CRITICAL: Validate test file syntax and execution using docker_exec with containerId='${containerId}'.

TASK: Comprehensive test validation and execution check.

TEST FILE TO VALIDATE: ${testFile?.testFile}

🔍 VALIDATION WORKFLOW:

PHASE 1: PROJECT SETUP AND DISCOVERY
1. Find project directory: docker_exec ls -la /app/ | grep "^d" | grep -v "\\." | awk '{print $NF}' | head -1
2. Change to project directory: cd /app/PROJECT_DIR
3. Check if test file exists: docker_exec test -f /app/PROJECT_DIR/${testFile?.testFile} && echo "EXISTS" || echo "MISSING"

PHASE 2: SYNTAX VALIDATION
4. Check TypeScript syntax: docker_exec cd /app/PROJECT_DIR && npx tsc --noEmit ${testFile?.testFile} 2>&1 || echo "SYNTAX_CHECK_COMPLETE"
5. Check for import/export errors: docker_exec cd /app/PROJECT_DIR && node -c ${testFile?.testFile?.replace('.ts', '.js')} 2>&1 || echo "IMPORT_CHECK_COMPLETE"

PHASE 3: VITEST EXECUTION ATTEMPT  
6. Install test dependencies if needed: docker_exec cd /app/PROJECT_DIR && npm list vitest || npm install vitest @types/node --save-dev
7. Try to run the specific test: docker_exec cd /app/PROJECT_DIR && npm test ${testFile?.testFile} 2>&1 || npx vitest run ${testFile?.testFile} 2>&1 || echo "TEST_EXECUTION_ATTEMPTED"

PHASE 4: COMPREHENSIVE ANALYSIS
8. Analyze any error patterns from above steps
9. Check test structure validity
10. Verify mock configurations are correct

🎯 ANALYSIS CRITERIA:
- Syntax errors (TypeScript compilation issues)
- Import/export problems
- Missing dependencies
- Mock configuration errors
- Test framework compatibility
- Runtime execution errors

RETURN VALIDATION RESULTS (JSON only):
{
  "syntaxValid": true|false,
  "executionSuccessful": true|false,
  "errorDetails": "[SPECIFIC_ERROR_MESSAGE_IF_ANY]",
  "needsRetry": true|false,
  "recommendations": ["[SPECIFIC_FIX_RECOMMENDATIONS]"]
}`;

                try {
                    const validationResult = await callAgent("unitTestAgent", validationPrompt, z.object({
                        syntaxValid: z.boolean(),
                        executionSuccessful: z.boolean(),
                        errorDetails: z.string().optional(),
                        needsRetry: z.boolean(),
                        recommendations: z.array(z.string()),
                    }), 300, runId, logger);

                    logger?.info("📊 Validation results received", {
                        syntaxValid: validationResult.syntaxValid,
                        executionSuccessful: validationResult.executionSuccessful,
                        hasErrors: !!validationResult.errorDetails,
                        needsRetry: validationResult.needsRetry,
                        type: "WORKFLOW_STEP",
                        runId: runId,
                    });

                    // If validation failed and we can retry, trigger retry path instead of early return
                    if (validationResult.needsRetry && retryCount < maxRetries && validationResult.errorDetails && repoAnalysis && testSpecs) {
                        logger?.warn("🔄 Validation failed, initiating retry with detailed error feedback", {
                            step: "3/3",
                            retryCount: retryCount + 1,
                            errorDetails: validationResult.errorDetails.substring(0, 200),
                            type: "WORKFLOW_STEP",
                            runId: runId,
                        });

                        isRetryPath = true;
                        executionResult = await retryTestGeneration(
                            containerId, 
                            repoAnalysis, 
                            testSpecs, 
                            retryCount + 1, 
                            validationResult.errorDetails, 
                            mastra, 
                            inputData.projectId, 
                            inputData.contextPath, 
                            runId, 
                            logger
                        );
                        
                        // Don't return here - let finally block handle notification
                        return executionResult;
                    }

                    // Update test generation quality based on validation
                    processedTestGeneration.quality.syntaxValid = validationResult.syntaxValid;
                    processedTestGeneration.quality.followsBestPractices = validationResult.syntaxValid && validationResult.executionSuccessful;
                    processedTestGeneration.quality.coverageScore = validationResult.executionSuccessful ? 85 : 50;

                } catch (validationError) {
                    logger?.warn("⚠️ Validation step failed, proceeding with basic assessment", {
                        step: "3/3",
                        error: validationError instanceof Error ? validationError.message : 'Unknown error',
                        type: "WORKFLOW_STEP",
                        runId: runId,
                    });
                    // Continue with original test generation quality scores
                }
            }

            // Phase 2: Generate Final Recommendations and Result
            const recommendations = generateRecommendations(processedTestGeneration, retryCount);
            const result = generateResultMessage(processedTestGeneration, retryCount);

            logger?.info("🏁 Step 3/3: Enhanced MVP test generation workflow completed", {
                step: "3/3",
                success: processedTestGeneration.summary.successfulFiles > 0,
                syntaxValid: processedTestGeneration.quality.syntaxValid,
                testFile: processedTestGeneration.testFiles[0]?.testFile || 'none',
                functionsCount: processedTestGeneration.summary.totalFunctions,
                testCasesCount: processedTestGeneration.summary.totalTestCases,
                coverageScore: processedTestGeneration.quality.coverageScore,
                toolCallCount: cliToolMetrics.callCount,
                retryCount,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            executionResult = {
                result,
                success: processedTestGeneration.summary.successfulFiles > 0,
                toolCallCount: cliToolMetrics.callCount,
                testGeneration: processedTestGeneration,
                recommendations,
                projectId: inputData.projectId,
                containerId,
                contextPath: inputData.contextPath,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };

            return executionResult;
            
        } catch (error) {
            executionError = error instanceof Error ? error : new Error('Unknown error in finalize step');
            
            logger?.error("❌ Step 3/3: Finalize step failed with exception", {
                step: "3/3",
                error: executionError.message,
                stack: executionError.stack?.substring(0, 500),
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            // Create fallback result for exception case
            executionResult = {
                result: `❌ Finalize step failed with error: ${executionError.message}`,
                success: false,
                toolCallCount: cliToolMetrics.callCount,
                testGeneration,
                recommendations: [
                    `❌ Finalize step encountered an exception: ${executionError.message}`,
                    "Review error logs and retry the workflow",
                    "Check Docker container connectivity and agent availability",
                    "Consider manual intervention if the error persists"
                ],
                projectId: inputData.projectId,
                containerId,
                contextPath: inputData.contextPath,
                targetTestFile: inputData.targetTestFile,
                workflowId: inputData.workflowId,
                workflowInstanceId: inputData.workflowInstanceId,
            };

            throw executionError; // Re-throw to trigger finally block
            
        } finally {
            // GUARANTEED completion notification - this will ALWAYS execute
            try {
                const finalSuccess = executionResult?.success ?? false;
                const finalSubtitle = isRetryPath 
                    ? (finalSuccess ? "Retry succeeded" : "Retry failed")
                    : (finalSuccess ? "Success" : "Completed with warnings");
                
                await ensureCompletionNotification(
                    "finalize-step",
                    executionError ? "failed" : "completed",
                    runId,
                    containerId,
                    inputData.projectId,
                    finalSuccess,
                    finalSubtitle,
                    executionError?.message,
                    inputData.workflowId,
                    inputData.workflowInstanceId
                );
                
                logger?.info("📤 Finalize step completion notification sent", {
                    success: finalSuccess,
                    hasError: !!executionError,
                    isRetryPath,
                    type: "NOTIFICATION",
                    runId: runId,
                });
                
            } catch (finalNotificationError) {
                // This should never happen due to the error handling in ensureCompletionNotification,
                // but we log it just in case
                console.error('🚨 Critical: Failed to send completion notification in finally block:', finalNotificationError);
            }
        }
    },
});

/**
 * Generate recommendations based on test generation results
 */
function generateRecommendations(testGeneration: z.infer<typeof TestGenerationResult>, retryCount: number): string[] {
    const recommendations = [];
    
    if (testGeneration.summary.successfulFiles > 0 && testGeneration.quality.syntaxValid) {
        recommendations.push(
            `✅ Run the validated test: npm test ${testGeneration.testFiles[0]?.testFile || ''}`,
            "Test file has been syntax-validated and is ready for execution",
            "Consider expanding to other high-priority modules",
            "Set up test automation in CI/CD pipeline",
            "Monitor test coverage and add additional test cases as needed"
        );
    } else if (testGeneration.summary.successfulFiles > 0) {
        recommendations.push(
            `⚠️ Test file created but may have syntax issues: ${testGeneration.testFiles[0]?.testFile || ''}`,
            "Review and fix any syntax errors before execution",
            "Check import statements and dependency mocking",
            "Verify vitest configuration is correct"
        );
    } else {
        recommendations.push(
            "❌ Test generation failed after retry attempts",
            "Review error logs for systematic issues",
            "Check source file accessibility and complexity",
            "Consider manual test creation as backup",
            "Verify Docker container has necessary dependencies"
        );
    }

    // Add retry-specific recommendations
    if (retryCount > 0) {
        recommendations.push(
            `📊 Completed ${retryCount} retry attempt(s) with error feedback`,
            "Review the progression of fixes applied during retries",
            "Consider the error patterns for future test generation improvements"
        );
    }

    // Add MVP-specific recommendations
    recommendations.push(
        "🎯 Enhanced MVP completed with validation - expand to other modules when ready",
        "📈 Review generated test quality and validation results",
        "📝 Document testing approach and validation patterns for team consistency"
    );

    return recommendations;
}

/**
 * Generate result message based on test generation results
 */
function generateResultMessage(testGeneration: z.infer<typeof TestGenerationResult>, retryCount: number): string {
    if (testGeneration.summary.successfulFiles > 0) {
        if (testGeneration.quality.syntaxValid) {
            return `✅ Enhanced MVP test generation successful with validation: ${testGeneration.testFiles[0]?.testFile || 'test file'} created and validated`;
        } else {
            return `⚠️ MVP test generation completed with syntax warnings: ${testGeneration.testFiles[0]?.testFile || 'test file'} created but needs review`;
        }
    } else {
        return `❌ Enhanced MVP test generation failed after ${retryCount} retry attempts - check logs for details`;
    }
}

// ============================================================================
// WORKFLOW DEFINITION
// ============================================================================

/**
 * Generate Unit Tests Workflow (MVP Version)
 * 
 * A streamlined 3-step MVP workflow that generates high-quality unit tests for
 * ONE high priority module using block-based manager-worker pattern with checkpoints.
 * 
 * Steps:
 * 0. Check Saved Plan - Fast static check for previously saved plan (no agent calls)
 * 1. Load Context & Plan - Analyze repository and select ONE high priority module for MVP
 * 2. Generate Tests - Use block-based manager-worker pattern with checkpoints
 * 3. Finalize - Simple summary and recommendations
 * 
 * MVP Features:
 * - Fast resume with static file checking
 * - Focus on single high-priority module for quick results
 * - Block-based generation with progress checkpoints
 * - Co-located test file placement
 * - Comprehensive error handling and fallback strategies
 * - Detailed logging and progress tracking
 * - Quality assessment and MVP-focused recommendations
 */
export const generateUnitTestsWorkflow = createWorkflow({
    id: "generate-unit-tests-workflow",
    description: "MVP workflow: Generate unit tests for ONE high priority module using block-based approach with checkpoints",
    inputSchema: WorkflowInput,
    outputSchema: UnitTestResult.extend({
        projectId: z.string(),
    }),
})
.then(checkSavedPlanStep)
.then(loadContextAndPlanStep)
.then(generateTestCodeStep)
.then(finalizeStep)
.commit();