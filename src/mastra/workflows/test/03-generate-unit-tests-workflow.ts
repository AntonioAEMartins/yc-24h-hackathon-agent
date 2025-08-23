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
 * Helper function to save analysis results for resume functionality
 */
async function saveAnalysisResults(containerId: string, analysisData: any, logger?: any): Promise<void> {
    const saveFilePath = `/tmp/analysis-${containerId.substring(0, 12)}.json`;
    
    try {
        const prompt = `Save analysis results for resume functionality using docker_exec with containerId='${containerId}'.

TASK: Save analysis data to file system for resume functionality.

Instructions:
1. Create the analysis file: echo '${JSON.stringify(analysisData).replace(/'/g, "'\\''")}' > ${saveFilePath}
2. Verify file was created: ls -la ${saveFilePath}

Save the analysis data so the workflow can resume from test generation step.`;

        await callAgent("unitTestAgent", prompt, z.object({
            success: z.boolean(),
            message: z.string(),
        }), 100, undefined, logger);
        
        logger?.info("💾 Analysis results saved for resume functionality", {
            saveFilePath,
            containerId: containerId.substring(0, 12),
            type: "ANALYSIS_SAVE"
        });
    } catch (error) {
        logger?.warn("⚠️ Failed to save analysis results", {
            saveFilePath,
            error: error instanceof Error ? error.message : 'Unknown error',
            type: "ANALYSIS_SAVE"
        });
    }
}

/**
 * Helper function to load saved analysis results
 */
async function loadAnalysisResults(containerId: string, logger?: any): Promise<any | null> {
    const saveFilePath = `/tmp/analysis-${containerId.substring(0, 12)}.json`;
    
    try {
        const prompt = `Check for and load saved analysis results using docker_exec with containerId='${containerId}'.

TASK: Load previously saved analysis data if it exists.

Instructions:
1. Check if analysis file exists: test -f ${saveFilePath} && echo "EXISTS" || echo "NOT_EXISTS"
2. If exists, read the file: cat ${saveFilePath}
3. Return the analysis data or indicate if not found

Return JSON indicating whether saved analysis was found and the data:
{
  "found": true/false,
  "data": { /* analysis data if found */ }
}`;

        const result = await callAgent("unitTestAgent", prompt, z.object({
            found: z.boolean(),
            data: z.any().optional(),
        }), 100, undefined, logger);
        
        if (result.found && result.data) {
            logger?.info("📂 Loaded saved analysis results", {
                saveFilePath,
                containerId: containerId.substring(0, 12),
                modulesFound: result.data.repoAnalysis?.sourceModules?.length || 0,
                testSpecsFound: result.data.testSpecs?.length || 0,
                type: "ANALYSIS_LOAD"
            });
            
            return result.data;
        }
        
        return null;
    } catch (error) {
        logger?.debug("No saved analysis found or failed to load", {
            saveFilePath,
            error: error instanceof Error ? error.message : 'Unknown error',
            type: "ANALYSIS_LOAD"
        });
        return null;
    }
}

// ============================================================================
// WORKFLOW STEPS
// ============================================================================

/**
 * Step 0: Check for Saved Analysis (Resume Functionality)
 * 
 * This step checks if there's a previously saved analysis for this container.
 * If found, it loads the saved data and skips the analysis steps, jumping
 * directly to test generation for faster iteration.
 */
const checkSavedAnalysisStep = createStep({
    id: "check-saved-analysis-step",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis.optional(),
        testSpecs: z.array(TestSpecification).optional(),
        skipAnalysis: z.boolean(),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, contextPath } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🔍 Step 0/4: Checking for saved analysis results", {
            step: "0/4",
            stepName: "Check Saved Analysis",
            containerId: containerId.substring(0, 12),
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        // Try to load saved analysis
        const savedData = await loadAnalysisResults(containerId, logger);
        
        if (savedData && savedData.repoAnalysis && savedData.testSpecs) {
            logger?.info("✅ Step 0/4: Found saved analysis, skipping to test generation", {
                step: "0/4", 
                savedModules: savedData.repoAnalysis.sourceModules?.length || 0,
                savedTestSpecs: savedData.testSpecs?.length || 0,
                testingFramework: savedData.repoAnalysis.testingFramework,
                type: "WORKFLOW_STEP",
                runId: runId,
            });
            
            return {
                containerId,
                contextPath,
                repoAnalysis: savedData.repoAnalysis,
                testSpecs: savedData.testSpecs,
                skipAnalysis: true,
            };
        } else {
            logger?.info("📋 Step 0/4: No saved analysis found, proceeding with full workflow", {
                step: "0/4",
                type: "WORKFLOW_STEP", 
                runId: runId,
            });
            
            return {
                containerId,
                contextPath,
                skipAnalysis: false,
            };
        }
    },
});

/**
 * Step 1: Load Context and Plan Testing Strategy
 * 
 * This step loads the repository context and creates a focused testing strategy.
 * It identifies the main source directories, key files to test, and determines
 * the appropriate testing framework and directory structure.
 */
const loadContextAndPlanStep = createStep({
    id: "load-context-and-plan-step",
    inputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis.optional(),
        testSpecs: z.array(TestSpecification).optional(),
        skipAnalysis: z.boolean(),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoAnalysis: RepoTestAnalysis,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, contextPath, repoAnalysis, skipAnalysis } = inputData;
        
        // If we have saved analysis, skip this step
        if (skipAnalysis && repoAnalysis) {
            const logger = mastra?.getLogger();
            logger?.info("⏭️ Step 1/4: Skipping context loading (using saved analysis)", {
                step: "1/4",
                stepName: "Load Context & Plan (Skipped)",
                type: "WORKFLOW_STEP",
                runId: runId,
            });
            
            return {
                containerId,
                contextPath,
                repoAnalysis,
            };
        }
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
        testSpecs: z.array(TestSpecification).optional(),
        skipAnalysis: z.boolean().optional(),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        repoAnalysis: RepoTestAnalysis,
        testSpecs: z.array(TestSpecification),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, repoAnalysis, testSpecs, skipAnalysis } = inputData;
        
        // If we have saved analysis, skip this step
        if (skipAnalysis && testSpecs) {
            const logger = mastra?.getLogger();
            logger?.info("⏭️ Step 2/4: Skipping source analysis (using saved test specs)", {
                step: "2/4",
                stepName: "Analyze & Specify (Skipped)",
                savedTestSpecs: testSpecs.length,
                type: "WORKFLOW_STEP",
                runId: runId,
            });
            
            return {
                containerId,
                repoAnalysis,
                testSpecs,
            };
        }
        const logger = mastra?.getLogger();
        
        logger?.info("🔍 Step 2/4: Analyzing source code and generating test specifications", {
            step: "2/4",
            stepName: "Analyze & Specify",
            modulesToAnalyze: repoAnalysis.sourceModules.length,
            type: "WORKFLOW_STEP",
            runId: runId,
        });

        const prompt = `CRITICAL: Return ONLY valid JSON. No explanations, no comments, no markdown - just pure JSON.

TASK: Generate test specifications for source files using docker_exec with containerId='${containerId}'.

Source Modules: ${JSON.stringify(repoAnalysis.sourceModules)}
Testing Framework: ${repoAnalysis.testingFramework}

ANALYSIS REQUIRED:
1. Read each source file: docker_exec cat <file_path>
2. Identify functions, methods, classes, exports
3. Generate comprehensive test cases for each function
4. Include edge cases, error scenarios, happy paths

RETURN FORMAT: Pure JSON only (no code blocks, no explanations):
{
  "testSpecs": [
    {
      "sourceFile": "path/to/file.ts",
      "functions": [
        {
          "name": "functionName",
          "testCases": [
            "detailed test case description 1",
            "detailed test case description 2"
          ]
        }
      ]
    }
  ]
}

REQUIREMENTS:
- Analyze ALL source files in the modules
- Generate 5-10 test cases per function minimum
- Include validation, error handling, and edge cases
- Be specific about expected behavior
- Test both success and failure scenarios

BEGIN ANALYSIS AND RETURN ONLY JSON:`;

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

            // Save analysis results for resume functionality
            const analysisData = {
                repoAnalysis,
                testSpecs: result.testSpecs,
                timestamp: new Date().toISOString(),
                version: "1.0"
            };
            await saveAnalysisResults(containerId, analysisData, logger);

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
        
        const managerPrompt = `CRITICAL: Return ONLY valid JSON. No explanations, no comments.

TASK: Plan test generation coordination using manager-worker pattern with containerId='${containerId}'.

Test Specifications: ${JSON.stringify(testSpecs)}
Testing Framework: ${repoAnalysis.testingFramework}
Test Directory Strategy: ${repoAnalysis.testDirectory}
Container ID: ${containerId}

COORDINATION WORKFLOW:
1. Log task start: task_logging agentId="testManager", taskId="plan-coordination", status="started"
2. For co-located tests: place .test.ts files next to source files
3. For separate directory: create __tests__ structure
4. Assign one source file per coding agent
5. Log planning completion: status="completed"

TEST FILE PLACEMENT RULES:
- If testDirectory contains "co-located": place test files next to source files
  Example: src/tools/cli-tool.ts → src/tools/cli-tool.test.ts
- If testDirectory is a path: create directory structure
  Example: src/tools/cli-tool.ts → __tests__/tools/cli-tool.test.ts

RETURN FORMAT (JSON only):
{
  "tasks": [
    {
      "taskId": "generate-test-1",
      "agentId": "testCoder-1",
      "sourceFile": "src/mastra/tools/cli-tool.ts",
      "testFile": "src/mastra/tools/cli-tool.test.ts",
      "testSpec": ${JSON.stringify(testSpecs[0] || {}, null, 2)},
      "priority": "high",
      "framework": "${repoAnalysis.testingFramework}"
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
                const coderPrompt = `CRITICAL: Return ONLY valid JSON. No explanations, no comments.

TASK: Generate complete ${task.framework || repoAnalysis.testingFramework} test file for ${task.sourceFile} using containerId='${containerId}'.

ASSIGNED WORK:
- Task ID: ${task.taskId}
- Agent: ${task.agentId}
- Source: ${task.sourceFile}
- Test File: ${task.testFile}
- Framework: ${task.framework || repoAnalysis.testingFramework}
- Priority: ${task.priority}

TEST SPECIFICATION:
${JSON.stringify(task.testSpec, null, 2)}

IMPLEMENTATION WORKFLOW:
1. Log start: task_logging agentId="${task.agentId}", taskId="${task.taskId}", status="started"
2. Log planning: status="planning"
3. Read source: docker_exec cat ${task.sourceFile}
4. Log coding: status="coding"
5. Generate complete test file with:
   - Proper imports (vitest: vi, expect, describe, it, beforeEach, afterEach)
   - Mock setup for external dependencies
   - Individual test cases for each function
   - Descriptive test names matching specifications
   - Proper assertions and expectations
   - Setup/teardown as needed
6. Write test file: docker_exec "cat > ${task.testFile} << 'EOF' [complete_test_content] EOF"
7. Log validation: status="validating"
8. Verify file creation: docker_exec cat ${task.testFile}
9. Log completion: status="completed"

CODE GENERATION REQUIREMENTS:
- Use ${task.framework || repoAnalysis.testingFramework} (vi.mock, vi.fn, expect, describe, it)
- Mock ALL external dependencies (child_process, fs, @mastra/core, etc.)
- Implement EVERY test case from the specification exactly
- Use descriptive test names that match the specification
- Include proper error scenarios and edge cases
- Add beforeEach/afterEach for state cleanup
- Follow TypeScript best practices
- Ensure all imports are correct and complete

RETURN FORMAT (JSON only):
{
  "sourceFile": "${task.sourceFile}",
  "testFile": "${task.testFile}",
  "functionsCount": <number_of_functions_tested>,
  "testCasesCount": <total_test_cases_implemented>,
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
    description: "Generate comprehensive unit tests using AI analysis, manager-worker pattern, and best practices with resume functionality",
    inputSchema: WorkflowInput,
    outputSchema: UnitTestResult,
})
.then(checkSavedAnalysisStep)
.then(loadContextAndPlanStep)
.then(analyzeAndSpecifyStep)  
.then(generateTestCodeStep)
.then(validateAndFinalizeStep)
.commit();