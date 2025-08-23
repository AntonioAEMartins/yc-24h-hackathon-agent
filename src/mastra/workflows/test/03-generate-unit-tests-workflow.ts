import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

/**
 * Input schema for the workflow - what we start with
 */
const WorkflowInput = z.object({
    containerId: z.string().describe("Docker container ID where the repository is mounted"),
    contextPath: z.string().optional().default("/app/agent.context.json").describe("Path to the context file"),
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
    agentName: "unitTestAgent" | "testAnalysisAgent" | "testSpecificationAgent" | "testGenerationAgent" | "testValidationAgent" | "dockerAgent" | "contextAgent" | "testManagerAgent" | "testCoderAgent",
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
    
    // Extract JSON from response
    let jsonText = text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
        jsonText = jsonMatch[1];
        logger?.debug(`📋 Extracted JSON from markdown`, {
            originalLength: text.length,
            extractedLength: jsonText.length,
            type: "JSON_EXTRACTION",
            runId: runId,
        });
    } else {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            jsonText = text.substring(start, end + 1);
            logger?.debug(`📋 Extracted JSON from boundaries`, {
                originalLength: text.length,
                extractedLength: jsonText.length,
                boundaries: { start, end },
                type: "JSON_EXTRACTION",
                runId: runId,
            });
        }
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
    } catch (error) {
        logger?.error(`❌ JSON parsing or validation failed`, {
            error: error instanceof Error ? error.message : 'Unknown error',
            jsonText: jsonText.substring(0, 500),
            type: "JSON_ERROR",
            runId: runId,
        });
        
        throw new Error(`JSON parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// ============================================================================
// WORKFLOW STEPS
// ============================================================================

/**
 * Step 1: Load Context and Plan Testing Strategy
 * 
 * This step loads the repository context and creates a focused testing strategy.
 * It identifies the main source directories, key files to test, and determines
 * the appropriate testing framework and directory structure.
 */
const loadContextAndPlanStep = createStep({
    id: "load-context-and-plan-step",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, contextPath } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("📋 Step 1/4: Loading repository context and planning unit test strategy", {
            step: "1/4",
            stepName: "Load Context & Plan",
            containerId,
            contextPath,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        const prompt = `Load repository context and create unit test generation plan using docker_exec with containerId='${containerId}'.

TASK: Load context and create a focused testing strategy.

Instructions:
1. Read the context file: cat ${contextPath}
2. Identify main source directories (src/, lib/, etc.)
3. List key source files for testing (find . -name "*.ts" -o -name "*.js" | grep -v test | grep -v node_modules | head -10)
4. Determine testing framework (jest, vitest, etc.)
5. Plan test directory structure

Return JSON with focused testing plan:
{
  "sourceModules": [
    {
      "modulePath": "src/mastra/agents",
      "sourceFiles": ["context-agent.ts", "unit-test-agent.ts"],
      "priority": "high",
      "language": "typescript"
    }
  ],
  "testingFramework": "jest",
  "testDirectory": "__tests__",
  "totalFiles": 5
}`;

        try {
            const result = await callAgent("unitTestAgent", prompt, RepoTestAnalysis, 1000, runId, logger);
            
            logger?.info("✅ Step 1/4: Context loaded and testing plan created", {
                step: "1/4",
                modulesFound: result.sourceModules.length,
                totalFiles: result.totalFiles,
                testingFramework: result.testingFramework,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            return {
                containerId,
                contextPath,
                repoAnalysis: result,
            };
        } catch (error) {
            logger?.error("❌ Step 1/4: Context loading failed", {
                step: "1/4",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            logger?.warn("🔄 Using fallback testing plan", {
                step: "1/4",
                action: "fallback",
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            // Return minimal fallback plan
            return {
                containerId,
                contextPath,
                repoAnalysis: {
                    sourceModules: [{
                        modulePath: "src",
                        sourceFiles: ["index.ts"],
                        priority: "medium" as const,
                        language: "typescript",
                    }],
                    testingFramework: "jest",
                    testDirectory: "__tests__",
                    totalFiles: 1,
                },
            };
        }
    },
});

/**
 * Step 2: Analyze Source Code and Generate Test Specifications
 * 
 * This step performs deep analysis of source files and generates comprehensive
 * test specifications. It identifies functions, methods, classes, and creates
 * detailed test cases covering normal scenarios, edge cases, and error handling.
 */
const analyzeAndSpecifyStep = createStep({
    id: "analyze-and-specify-step",
    inputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis,
    }),
    outputSchema: z.object({
        containerId: z.string(),
        repoAnalysis: RepoTestAnalysis,
        testSpecs: z.array(TestSpecification),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, repoAnalysis } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🔍 Step 2/4: Analyzing source code and generating test specifications", {
            step: "2/4",
            stepName: "Analyze & Specify",
            modulesToAnalyze: repoAnalysis.sourceModules.length,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        const prompt = `Analyze source files and generate comprehensive test specifications using docker_exec with containerId='${containerId}'.

TASK: Deep analysis and test specification generation.

Source Modules: ${JSON.stringify(repoAnalysis.sourceModules)}
Testing Framework: ${repoAnalysis.testingFramework}

Instructions:
1. For each source file, analyze the code structure
2. Identify all functions, methods, and classes
3. Generate test specifications covering:
   - Normal/happy path cases
   - Edge cases and boundary conditions
   - Error handling scenarios
4. Plan mocking strategy for dependencies

Return JSON with test specifications:
{
  "testSpecs": [
    {
      "sourceFile": "src/mastra/agents/context-agent.ts",
      "functions": [
        {
          "name": "createAgent",
          "testCases": [
            "should create agent with valid config",
            "should throw error with invalid config",
            "should handle missing dependencies"
          ]
        }
      ]
    }
  ]
}`;

        try {
            const result = await callAgent("unitTestAgent", prompt, z.object({
                testSpecs: z.array(TestSpecification),
            }), 1000, runId, logger);
            
            const totalFunctions = result.testSpecs.reduce((acc, spec) => acc + spec.functions.length, 0);
            const totalTestCases = result.testSpecs.reduce((acc, spec) => 
                acc + spec.functions.reduce((funcAcc, func) => funcAcc + func.testCases.length, 0), 0);
            
            logger?.info("✅ Step 2/4: Source analysis and test specification completed", {
                step: "2/4",
                filesAnalyzed: result.testSpecs.length,
                functionsFound: totalFunctions,
                testCasesPlanned: totalTestCases,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            return {
                containerId,
                repoAnalysis,
                testSpecs: result.testSpecs,
            };
        } catch (error) {
            logger?.error("❌ Step 2/4: Source analysis failed", {
                step: "2/4",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW_STEP",
                runId: runId,
            });
            throw error;
        }
    },
});

/**
 * Step 3: Generate Unit Test Code using Manager-Worker Pattern
 * 
 * This step implements a sophisticated manager-worker pattern where:
 * - A Test Manager Agent coordinates the overall process
 * - Multiple Test Coder Agents work on individual test files in parallel
 * - Task distribution prevents merge conflicts by assigning one file per agent
 * - Progress is tracked using the task logging system
 */
const generateTestCodeStep = createStep({
    id: "generate-test-code-step",
    inputSchema: z.object({
        containerId: z.string(),
        repoAnalysis: RepoTestAnalysis,
        testSpecs: z.array(TestSpecification),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        testGeneration: TestGenerationResult,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, repoAnalysis, testSpecs } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🏗️ Step 3/4: Generating unit test code using Manager-Worker pattern", {
            step: "3/4",
            stepName: "Generate Tests",
            testFilesToGenerate: testSpecs.length,
            framework: repoAnalysis.testingFramework,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        // ====================================================================
        // PHASE 1: Manager Agent - Plan Task Distribution
        // ====================================================================
        
        const managerPrompt = `You are the Test Manager Agent coordinating test generation for ${testSpecs.length} source files.

TASK: Plan and coordinate test generation using manager-worker pattern.

Test Specifications: ${JSON.stringify(testSpecs)}
Testing Framework: ${repoAnalysis.testingFramework}
Test Directory: ${repoAnalysis.testDirectory}
Container ID: ${containerId}

COORDINATION STRATEGY:
1. Use task_logging tool to log planning phase start
2. Create task distribution plan (one test file per coding agent)
3. Plan test file paths to avoid conflicts
4. Set up test directory structure
5. Return coordination plan for coding agents

TASK DISTRIBUTION RULES:
- Assign one source file → one test file per coding agent
- Use unique agent IDs (testCoder-1, testCoder-2, etc.)
- Plan file paths to avoid conflicts
- Prioritize high-priority files first
- Balance workload across agents

INSTRUCTIONS:
1. Log task start: task_logging with agentId="testManager", taskId="plan-coordination", status="started"
2. Create test directory: docker_exec mkdir -p ${repoAnalysis.testDirectory}
3. Plan task assignments for ${testSpecs.length} coding agents
4. Log planning completion: status="completed"

Return JSON with task assignments:
{
  "tasks": [
    {
      "taskId": "generate-test-1",
      "agentId": "testCoder-1", 
      "sourceFile": "src/mastra/agents/context-agent.ts",
      "testFile": "__tests__/agents/context-agent.test.ts",
      "testSpec": { /* test specification */ },
      "priority": "high"
    }
  ]
}`;

        let taskPlan;
        try {
            taskPlan = await callAgent("testManagerAgent", managerPrompt, z.object({
                tasks: z.array(CodingTask),
            }), 1000, runId, logger);
            
            logger?.info("✅ Manager: Task distribution plan created", {
                step: "3/4",
                phase: "planning",
                tasksPlanned: taskPlan.tasks.length,
                type: "WORKFLOW_STEP",
                runId: runId,
            });
        } catch (error) {
            logger?.error("❌ Manager: Task planning failed", {
                step: "3/4",
                phase: "planning",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW_STEP",
                runId: runId,
            });
            throw error;
        }

        // ====================================================================
        // PHASE 2: Coding Agents - Parallel Test Generation
        // ====================================================================
        
        logger?.info("🤖 Starting parallel test generation with coding agents", {
            step: "3/4", 
            phase: "coding",
            codingAgents: taskPlan.tasks.length,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        const testResults: z.infer<typeof TestFileResult>[] = [];
        
        // Process tasks in parallel batches to avoid overwhelming the system
        const batchSize = 3; // Process 3 files at a time
        for (let i = 0; i < taskPlan.tasks.length; i += batchSize) {
            const batch = taskPlan.tasks.slice(i, i + batchSize);
            
            logger?.info(`🔄 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(taskPlan.tasks.length/batchSize)}`, {
                step: "3/4",
                phase: "coding",
                batchSize: batch.length,
                batchFiles: batch.map(t => t.sourceFile),
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            const batchPromises = batch.map(async (task) => {
                const coderPrompt = `You are Test Coder Agent ${task.agentId} generating unit tests for a specific source file.

ASSIGNED TASK: ${task.taskId}
Source File: ${task.sourceFile}
Test File: ${task.testFile}
Priority: ${task.priority}

Test Specification: ${JSON.stringify(task.testSpec)}
Testing Framework: ${repoAnalysis.testingFramework}
Container ID: ${containerId}

WORKFLOW:
1. Log task start: task_logging with agentId="${task.agentId}", taskId="${task.taskId}", status="started"
2. Log planning phase: status="planning" 
3. Analyze source file: docker_exec cat ${task.sourceFile}
4. Log coding phase: status="coding"
5. Generate comprehensive test file with proper structure
6. Create test file: docker_exec 'echo "test_content" > ${task.testFile}'
7. Log validation phase: status="validating"
8. Validate syntax and imports
9. Log completion: status="completed"

QUALITY REQUIREMENTS:
- Follow ${repoAnalysis.testingFramework} best practices
- Include proper imports, setup, and teardown
- Write descriptive test names and meaningful assertions
- Add proper mocking for dependencies
- Cover all test cases from specification
- Ensure clean, readable code with comments

Return JSON with generation result:
{
  "sourceFile": "${task.sourceFile}",
  "testFile": "${task.testFile}",
  "functionsCount": 3,
  "testCasesCount": 9,
  "success": true,
  "error": null
}`;

                try {
                    const result = await callAgent("testCoderAgent", coderPrompt, TestFileResult, 1000, runId, logger);
                    
                    logger?.debug(`✅ Coding Agent ${task.agentId}: Test generation completed`, {
                        step: "3/4",
                        phase: "coding",
                        agentId: task.agentId,
                        sourceFile: task.sourceFile,
                        testCases: result.testCasesCount,
                        type: "WORKFLOW_STEP",
                        runId: runId,
                    });
                    
                    return result;
                } catch (error) {
                    logger?.error(`❌ Coding Agent ${task.agentId}: Test generation failed`, {
                        step: "3/4",
                        phase: "coding",
                        agentId: task.agentId,
                        sourceFile: task.sourceFile,
                        error: error instanceof Error ? error.message : 'Unknown error',
                        type: "WORKFLOW_STEP",
                        runId: runId,
                    });
                    
                    // Return failure result instead of throwing
                    return {
                        sourceFile: task.sourceFile,
                        testFile: task.testFile,
                        functionsCount: 0,
                        testCasesCount: 0,
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error',
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            testResults.push(...batchResults);
            
            logger?.info(`✅ Batch ${Math.floor(i/batchSize) + 1} completed`, {
                step: "3/4",
                phase: "coding",
                batchSuccess: batchResults.filter(r => r.success).length,
                batchFailed: batchResults.filter(r => !r.success).length,
                type: "WORKFLOW_STEP", 
                runId: runId,
            });
        }

        // ====================================================================
        // PHASE 3: Manager Agent - Aggregate Results
        // ====================================================================
        
        const successfulFiles = testResults.filter(r => r.success).length;
        const failedFiles = testResults.filter(r => !r.success).length;
        const totalFunctions = testResults.reduce((acc, r) => acc + r.functionsCount, 0);
        const totalTestCases = testResults.reduce((acc, r) => acc + r.testCasesCount, 0);

        const aggregationPrompt = `You are the Test Manager Agent finalizing test generation results.

TASK: Aggregate and validate test generation results.

Generated Results: ${JSON.stringify(testResults)}
Container ID: ${containerId}

SUMMARY:
- Total Files: ${testResults.length}
- Successful: ${successfulFiles}
- Failed: ${failedFiles}
- Total Functions: ${totalFunctions}
- Total Test Cases: ${totalTestCases}

INSTRUCTIONS:
1. Log aggregation start: task_logging with agentId="testManager", taskId="aggregate-results", status="started"
2. Validate overall test structure and quality
3. Assess test coverage and best practices compliance
4. Log completion: status="completed"

Return quality assessment:
{
  "syntaxValid": true,
  "followsBestPractices": true,
  "coverageScore": 85
}`;

        let qualityAssessment;
        try {
            qualityAssessment = await callAgent("testManagerAgent", aggregationPrompt, z.object({
                syntaxValid: z.boolean(),
                followsBestPractices: z.boolean(),
                coverageScore: z.number(),
            }), 1000, runId, logger);
        } catch (error) {
            logger?.warn("⚠️ Manager: Quality assessment failed, using defaults", {
                step: "3/4",
                phase: "aggregation",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW_STEP",
                runId: runId,
            });
            
            qualityAssessment = {
                syntaxValid: successfulFiles > 0,
                followsBestPractices: successfulFiles === testResults.length,
                coverageScore: Math.round((successfulFiles / testResults.length) * 100),
            };
        }

        const testGeneration: z.infer<typeof TestGenerationResult> = {
            testFiles: testResults,
            summary: {
                totalSourceFiles: testSpecs.length,
                totalTestFiles: successfulFiles,
                totalFunctions,
                totalTestCases,
                successfulFiles,
                failedFiles,
            },
            quality: qualityAssessment,
        };

        logger?.info("✅ Step 3/4: Unit test code generation completed", {
            step: "3/4",
            testFilesGenerated: successfulFiles,
            testFilesFailed: failedFiles,
            totalTestCases,
            coverageScore: qualityAssessment.coverageScore,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        return {
            containerId,
            testGeneration,
        };
    },
});

/**
 * Step 4: Validate and Finalize
 * 
 * This step validates the generated tests and provides final recommendations
 * for improving the testing strategy and next steps.
 */
const validateAndFinalizeStep = createStep({
    id: "validate-and-finalize-step",
    inputSchema: z.object({
        containerId: z.string(),
        testGeneration: TestGenerationResult,
    }),
    outputSchema: UnitTestResult,
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, testGeneration } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("✅ Step 4/4: Validating tests and generating final summary", {
            step: "4/4",
            stepName: "Validate & Finalize",
            testFilesToValidate: testGeneration.testFiles.length,
            successfulFiles: testGeneration.summary.successfulFiles,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        const prompt = `Validate generated tests and create final recommendations using docker_exec with containerId='${containerId}'.

TASK: Validate test quality and provide recommendations.

Generated Tests Summary: ${JSON.stringify(testGeneration.summary)}
Quality Assessment: ${JSON.stringify(testGeneration.quality)}

Instructions:
1. Check test file syntax for successful generations
2. Verify imports and dependencies are correct
3. Validate test structure and assertions
4. Generate recommendations for improvement
5. Suggest next steps for the testing strategy

Return recommendations and validation results.`;

        try {
            const validationResult = await callAgent("unitTestAgent", prompt, z.object({
                validationPassed: z.boolean(),
                recommendations: z.array(z.string()),
            }), 1000, runId, logger);
            
            const recommendations = validationResult.recommendations.length > 0 ? validationResult.recommendations : [
                "Run the generated tests to ensure they pass",
                "Review test coverage and add integration tests if needed", 
                "Set up CI/CD pipeline to run tests automatically",
                "Consider adding performance tests for critical functions",
                ...(testGeneration.summary.failedFiles > 0 ? [
                    `Review and fix ${testGeneration.summary.failedFiles} failed test file generations`,
                    "Check error logs and regenerate failed test files manually"
                ] : [])
            ];
            
            logger?.info("✅ Step 4/4: Unit test generation workflow completed successfully", {
                step: "4/4",
                success: true,
                testFilesCreated: testGeneration.summary.successfulFiles,
                testFilesFailed: testGeneration.summary.failedFiles,
                totalTestCases: testGeneration.summary.totalTestCases,
                coverageScore: testGeneration.quality.coverageScore,
                toolCallCount: cliToolMetrics.callCount,
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            return {
                result: testGeneration.summary.failedFiles === 0 
                    ? "Unit tests generated successfully for all files"
                    : `Unit tests generated with ${testGeneration.summary.failedFiles} partial failures`,
                success: testGeneration.summary.successfulFiles > 0,
                toolCallCount: cliToolMetrics.callCount,
                testGeneration,
                recommendations,
            };
        } catch (error) {
            logger?.error("❌ Step 4/4: Validation failed", {
                step: "4/4",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW_STEP",
                runId: runId,
            });

            // Return partial success with fallback recommendations
            return {
                result: testGeneration.summary.successfulFiles > 0
                    ? "Unit tests generated with validation warnings"
                    : "Unit test generation completed with issues",
                success: testGeneration.summary.successfulFiles > 0,
                toolCallCount: cliToolMetrics.callCount,
                testGeneration,
                recommendations: [
                    "Manual review of generated tests recommended",
                    "Verify test syntax and imports",
                    "Run tests locally to ensure they work",
                    "Consider refining test coverage",
                    ...(testGeneration.summary.failedFiles > 0 ? [
                        `Review and fix ${testGeneration.summary.failedFiles} failed test file generations`
                    ] : [])
                ],
            };
        }
    },
});

// ============================================================================
// WORKFLOW DEFINITION
// ============================================================================

/**
 * Generate Unit Tests Workflow
 * 
 * A comprehensive 4-step workflow that generates high-quality unit tests using
 * AI agents and a sophisticated manager-worker pattern for parallel processing.
 * 
 * Steps:
 * 1. Load Context & Plan - Analyze repository and create testing strategy
 * 2. Analyze & Specify - Generate detailed test specifications for each file
 * 3. Generate Tests - Use manager-worker pattern for parallel test code generation
 * 4. Validate & Finalize - Validate results and provide recommendations
 * 
 * Features:
 * - Manager-worker pattern prevents merge conflicts
 * - Parallel processing for high-speed development
 * - Comprehensive error handling and fallback strategies
 * - Detailed logging and progress tracking
 * - Quality assessment and validation
 * - Actionable recommendations for next steps
 */
export const generateUnitTestsWorkflow = createWorkflow({
    id: "generate-unit-tests-workflow",
    description: "Generate comprehensive unit tests using AI analysis, manager-worker pattern, and best practices",
    inputSchema: WorkflowInput,
    outputSchema: UnitTestResult,
})
.then(loadContextAndPlanStep)
.then(analyzeAndSpecifyStep)  
.then(generateTestCodeStep)
.then(validateAndFinalizeStep)
.commit();