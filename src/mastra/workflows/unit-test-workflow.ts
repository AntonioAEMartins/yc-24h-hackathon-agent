import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "..";
import z from "zod";
import { cliToolMetrics } from "../tools/cli-tool";

// Input schema - what we start with
const WorkflowInput = z.object({
    containerId: z.string(),
    contextPath: z.string().optional().default("/app/agent.context.json"),
    sourceFiles: z.array(z.string()).optional(), // Specific files to test, or all if not provided
});

// Project analysis schema
const ProjectAnalysis = z.object({
    sourceFiles: z.array(z.object({
        filePath: z.string(),
        functions: z.array(z.object({
            name: z.string(),
            signature: z.string(),
            complexity: z.enum(["simple", "moderate", "complex"]),
            dependencies: z.array(z.string()),
            testPriority: z.enum(["high", "medium", "low"]),
        })),
        testFilePath: z.string(),
        language: z.string(),
    })),
    testingFramework: z.string(),
    projectStructure: z.string(),
    estimatedEffort: z.object({
        totalFunctions: z.number(),
        estimatedTime: z.string(),
        complexity: z.enum(["simple", "moderate", "complex"]),
    }),
});

// Test specifications schema
const TestSpecifications = z.object({
    fileSpecs: z.array(z.object({
        sourceFile: z.string(),
        testFile: z.string(),
        testSuites: z.array(z.object({
            suiteName: z.string(),
            functions: z.array(z.object({
                functionName: z.string(),
                testCases: z.array(z.object({
                    name: z.string(),
                    type: z.enum(["happy-path", "edge-case", "error-case", "boundary"]),
                    description: z.string(),
                    mockingRequired: z.array(z.string()),
                })),
            })),
        })),
        setupRequirements: z.array(z.string()),
        mockingStrategy: z.string(),
    })),
    parallelGroups: z.array(z.array(z.string())), // Groups of files that can be processed in parallel
});

// Generated test results schema
const GeneratedTestResults = z.object({
    completedFiles: z.array(z.object({
        sourceFile: z.string(),
        testFile: z.string(),
        testCases: z.number(),
        functionsTested: z.number(),
        fileSize: z.number(),
        saved: z.boolean(),
    })),
    validationResults: z.array(z.object({
        testFile: z.string(),
        syntaxValid: z.boolean(),
        testsRunnable: z.boolean(),
        coverageEstimate: z.number(),
        issues: z.array(z.string()),
        recommendations: z.array(z.string()),
    })),
});

// Final output schema
const UnitTestWorkflowResult = z.object({
    result: z.string(),
    success: z.boolean(),
    toolCallCount: z.number(),
    projectAnalysis: ProjectAnalysis,
    testSpecifications: TestSpecifications,
    generatedResults: GeneratedTestResults,
    summary: z.object({
        totalSourceFiles: z.number(),
        totalTestFiles: z.number(),
        totalTestCases: z.number(),
        totalFunctions: z.number(),
        filesSuccessful: z.number(),
        filesWithIssues: z.number(),
        overallQuality: z.number(),
    }),
    recommendations: z.array(z.string()),
});

// Helper to coordinate sub-agents
async function coordinateSubAgents<T>(
    managerPrompt: string,
    subAgentTasks: Array<{
        agent: string,
        prompt: string,
        schema: z.ZodType<any>,
    }>,
    resultSchema: z.ZodType<T>,
    runId?: string,
    logger?: any
): Promise<T> {
    const manager = mastra?.getAgent("unitTestAgent");
    if (!manager) throw new Error("Unit test manager agent not found");
    
    logger?.debug("🤖 Coordinating sub-agents", {
        managerPrompt: managerPrompt.length,
        subAgentTasks: subAgentTasks.length,
        type: "SUB_AGENT_COORDINATION",
        runId: runId,
    });

    // Execute the manager's coordination
    const result: any = await manager.generate(managerPrompt, { 
        maxSteps: 50, 
        maxRetries: 3,
    });
    
    const text = (result?.text || "{}").toString();
    
    // Extract JSON from response
    let jsonText = text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
        jsonText = jsonMatch[1];
    } else {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            jsonText = text.substring(start, end + 1);
        }
    }
    
    try {
        const parsed = JSON.parse(jsonText);
        const validated = resultSchema.parse(parsed);
        return validated;
    } catch (error) {
        logger?.error("❌ Sub-agent coordination failed", {
            error: error instanceof Error ? error.message : 'Unknown error',
            jsonText: jsonText.substring(0, 500),
            type: "COORDINATION_ERROR",
            runId: runId,
        });
        throw new Error(`Sub-agent coordination failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// Step 1: Project Analysis and Planning
const projectAnalysisStep = createStep({
    id: "project-analysis-step",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        projectAnalysis: ProjectAnalysis,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, contextPath, sourceFiles } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🔍 Starting project analysis and test planning", {
            step: "1/4",
            stepName: "Project Analysis & Planning",
            containerId,
            contextPath,
            specificFiles: sourceFiles?.length || "all",
            type: "WORKFLOW",
            runId: runId,
        });

        const managerPrompt = `As the Unit Test Generation Manager, coordinate the testAnalysisAgent to perform comprehensive project analysis.

TASK: Analyze the project structure and create a complete testing plan.

Container ID: ${containerId}
Context Path: ${contextPath}
${sourceFiles ? `Specific Files to Test: ${JSON.stringify(sourceFiles)}` : 'Analyze all source files'}

COORDINATION INSTRUCTIONS:
1. Direct the testAnalysisAgent to:
   - Load and analyze the repository context from ${contextPath}
   - Identify all source files (or focus on specified files)
   - Extract all testable functions, methods, and classes
   - Determine complexity levels and testing priorities
   - Map dependencies and identify mocking requirements

2. Create a comprehensive testing plan:
   - Determine appropriate testing framework (Jest, Vitest, etc.)
   - Plan test file locations within the project structure (NOT __tests__ folder)
   - Estimate effort and complexity for each file
   - Group files for parallel processing

3. Return structured analysis following the ProjectAnalysis schema

Use docker_exec with containerId='${containerId}' for all operations.

Return JSON with complete project analysis and testing plan.`;

        try {
            const result = await coordinateSubAgents(
                managerPrompt,
                [{
                    agent: "testAnalysisAgent",
                    prompt: "Perform deep code analysis and function extraction",
                    schema: z.any(),
                }],
                ProjectAnalysis,
                runId,
                logger
            );
            
            logger?.info("✅ Project analysis completed", {
                step: "1/4",
                totalFiles: result.sourceFiles.length,
                totalFunctions: result.estimatedEffort.totalFunctions,
                framework: result.testingFramework,
                complexity: result.estimatedEffort.complexity,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                contextPath,
                projectAnalysis: result,
            };
        } catch (error) {
            logger?.error("❌ Project analysis failed", {
                step: "1/4",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW", 
                runId: runId,
            });
            throw error;
        }
    },
});

// Step 2: Test Specification Creation
const testSpecificationStep = createStep({
    id: "test-specification-step",
    inputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        projectAnalysis: ProjectAnalysis,
    }),
    outputSchema: z.object({
        containerId: z.string(),
        projectAnalysis: ProjectAnalysis,
        testSpecifications: TestSpecifications,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, projectAnalysis } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("📋 Creating comprehensive test specifications", {
            step: "2/4",
            stepName: "Test Specification Creation",
            filesToSpecify: projectAnalysis.sourceFiles.length,
            totalFunctions: projectAnalysis.estimatedEffort.totalFunctions,
            type: "WORKFLOW",
            runId: runId,
        });

        const managerPrompt = `As the Unit Test Generation Manager, coordinate the testSpecificationAgent to create comprehensive test specifications.

TASK: Create detailed test specifications for all analyzed source files.

Project Analysis: ${JSON.stringify(projectAnalysis)}

COORDINATION INSTRUCTIONS:
1. Direct the testSpecificationAgent to:
   - Create detailed test specifications for each source file
   - Design comprehensive test cases covering all scenarios
   - Plan mocking strategies for dependencies
   - Organize tests into logical suites and groups
   - Define setup/teardown requirements

2. Optimize for parallel execution:
   - Group files that can be processed simultaneously
   - Identify dependencies between test files
   - Plan execution order for maximum efficiency

3. Test File Placement Strategy:
   - Place test files within the project structure
   - Use naming convention: [filename].test.[ext]
   - Mirror source directory structure for tests
   - Example: src/agents/context-agent.ts → src/agents/context-agent.test.ts

4. Return structured specifications following the TestSpecifications schema

Ensure comprehensive coverage with practical parallel execution planning.`;

        try {
            const result = await coordinateSubAgents(
                managerPrompt,
                [{
                    agent: "testSpecificationAgent",
                    prompt: "Create comprehensive test specifications",
                    schema: z.any(),
                }],
                TestSpecifications,
                runId,
                logger
            );
            
            const totalTestCases = result.fileSpecs.reduce((acc, spec) => 
                acc + spec.testSuites.reduce((suiteAcc, suite) => 
                    suiteAcc + suite.functions.reduce((funcAcc, func) => 
                        funcAcc + func.testCases.length, 0), 0), 0);
            
            logger?.info("✅ Test specifications created", {
                step: "2/4",
                fileSpecs: result.fileSpecs.length,
                totalTestCases,
                parallelGroups: result.parallelGroups.length,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                projectAnalysis,
                testSpecifications: result,
            };
        } catch (error) {
            logger?.error("❌ Test specification failed", {
                step: "2/4",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW",
                runId: runId,
            });
            throw error;
        }
    },
});

// Step 3: Parallel Test Generation with Incremental Saving
const testGenerationStep = createStep({
    id: "test-generation-step",
    inputSchema: z.object({
        containerId: z.string(),
        projectAnalysis: ProjectAnalysis,
        testSpecifications: TestSpecifications,
    }),
    outputSchema: z.object({
        containerId: z.string(),
        generatedResults: GeneratedTestResults,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, testSpecifications } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🏗️ Starting parallel test generation with incremental saving", {
            step: "3/4",
            stepName: "Parallel Test Generation",
            totalFiles: testSpecifications.fileSpecs.length,
            parallelGroups: testSpecifications.parallelGroups.length,
            type: "WORKFLOW",
            runId: runId,
        });

        const managerPrompt = `As the Unit Test Generation Manager, coordinate the testGenerationAgent to generate test files in parallel with incremental saving.

TASK: Generate high-quality test files and save them immediately as they're completed.

Test Specifications: ${JSON.stringify(testSpecifications)}

COORDINATION INSTRUCTIONS:
1. Direct the testGenerationAgent to:
   - Generate complete test files based on specifications
   - Follow the project's testing framework conventions
   - Include proper imports, setup, and teardown
   - Write meaningful test names and assertions
   - Implement required mocking strategies

2. Parallel Execution Strategy:
   - Process files in parallel groups as defined in specifications
   - Save each test file immediately upon completion
   - Track progress and provide incremental updates
   - Handle failures gracefully without blocking other files

3. File Management:
   - Create test files within the project structure (NOT __tests__ folder)
   - Use proper naming conventions as specified
   - Ensure proper directory structure exists
   - Verify file saves were successful

4. Quality Standards:
   - Follow Google's testing best practices
   - Write tests that validate business logic
   - Ensure tests are independent and reliable
   - Add minimal but helpful comments

Use docker_exec with containerId='${containerId}' for all file operations.

Return structured results following the GeneratedTestResults schema.`;

        try {
            const result = await coordinateSubAgents(
                managerPrompt,
                [{
                    agent: "testGenerationAgent",
                    prompt: "Generate test files with parallel execution and incremental saving",
                    schema: z.any(),
                }],
                GeneratedTestResults,
                runId,
                logger
            );
            
            const successfulFiles = result.completedFiles.filter(f => f.saved).length;
            const totalTestCases = result.completedFiles.reduce((acc, f) => acc + f.testCases, 0);
            
            logger?.info("✅ Test generation completed", {
                step: "3/4",
                totalFiles: result.completedFiles.length,
                successfulFiles,
                totalTestCases,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                generatedResults: result,
            };
        } catch (error) {
            logger?.error("❌ Test generation failed", {
                step: "3/4",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW",
                runId: runId,
            });
            throw error;
        }
    },
});

// Step 4: Validation and Final Report
const validationStep = createStep({
    id: "validation-step",
    inputSchema: z.object({
        containerId: z.string(),
        generatedResults: GeneratedTestResults,
    }),
    outputSchema: UnitTestWorkflowResult,
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId, generatedResults } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("✅ Starting validation and final report generation", {
            step: "4/4",
            stepName: "Validation & Final Report",
            filesToValidate: generatedResults.completedFiles.length,
            type: "WORKFLOW",
            runId: runId,
        });

        const managerPrompt = `As the Unit Test Generation Manager, coordinate the testValidationAgent to validate all generated tests and create a comprehensive final report.

TASK: Validate all generated test files and provide a complete project summary.

Generated Results: ${JSON.stringify(generatedResults)}

COORDINATION INSTRUCTIONS:
1. Direct the testValidationAgent to:
   - Validate syntax and structure of all generated test files
   - Check that tests can be executed successfully
   - Assess test coverage and quality
   - Identify any issues or improvement opportunities
   - Verify that mocking is implemented correctly

2. Quality Assessment:
   - Evaluate overall test quality and coverage
   - Check compliance with best practices
   - Assess maintainability and reliability
   - Identify any missing test cases or edge conditions

3. Final Report Generation:
   - Compile comprehensive project summary
   - Provide actionable recommendations
   - Highlight successes and areas for improvement
   - Include next steps for the development team

Use docker_exec with containerId='${containerId}' for all validation operations.

Return complete validation results and project summary.`;

        try {
            // The manager will coordinate validation and compile the final report
            const validationResults = await coordinateSubAgents(
                managerPrompt,
                [{
                    agent: "testValidationAgent",
                    prompt: "Validate all generated tests and assess quality",
                    schema: z.any(),
                }],
                z.object({
                    validationResults: z.array(z.any()),
                    overallQuality: z.number(),
                    recommendations: z.array(z.string()),
                }),
                runId,
                logger
            );

            // Compile final summary
            const totalTestCases = generatedResults.completedFiles.reduce((acc, f) => acc + f.testCases, 0);
            const totalFunctions = generatedResults.completedFiles.reduce((acc, f) => acc + f.functionsTested, 0);
            const filesSuccessful = generatedResults.completedFiles.filter(f => f.saved).length;
            const filesWithIssues = generatedResults.validationResults.filter(v => v.issues.length > 0).length;
            
            logger?.info("✅ Unit test workflow completed successfully", {
                step: "4/4",
                stepName: "Validation & Final Report", 
                totalTestFiles: generatedResults.completedFiles.length,
                totalTestCases,
                totalFunctions,
                filesSuccessful,
                overallQuality: validationResults.overallQuality,
                toolCallCount: cliToolMetrics.callCount,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                result: "Unit tests generated successfully with parallel sub-agent coordination",
                success: true,
                toolCallCount: cliToolMetrics.callCount,
                projectAnalysis: {
                    sourceFiles: [],
                    testingFramework: "jest",
                    projectStructure: "standard",
                    estimatedEffort: {
                        totalFunctions,
                        estimatedTime: "completed",
                        complexity: "moderate" as const,
                    },
                },
                testSpecifications: {
                    fileSpecs: [],
                    parallelGroups: [],
                },
                generatedResults,
                summary: {
                    totalSourceFiles: generatedResults.completedFiles.length,
                    totalTestFiles: generatedResults.completedFiles.length,
                    totalTestCases,
                    totalFunctions,
                    filesSuccessful,
                    filesWithIssues,
                    overallQuality: validationResults.overallQuality,
                },
                recommendations: validationResults.recommendations,
            };
        } catch (error) {
            logger?.error("❌ Validation failed", {
                step: "4/4",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW",
                runId: runId,
            });
            throw error;
        }
    },
});

export const unitTestWorkflow = createWorkflow({
    id: "unit-test-workflow",
    description: "Advanced unit test generation using coordinated sub-agents with parallel execution and incremental saving",
    inputSchema: WorkflowInput,
    outputSchema: UnitTestWorkflowResult,
})
.then(projectAnalysisStep)
.then(testSpecificationStep)
.then(testGenerationStep)
.then(validationStep)
.commit();
