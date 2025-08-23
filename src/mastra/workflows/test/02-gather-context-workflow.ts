import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";

// Input schema - what we start with
const WorkflowInput = z.object({
    containerId: z.string(),
});

// Repository structure schema
const RepositoryStructure = z.object({
    type: z.enum(["monorepo", "single-package", "multi-project"]),
    rootPath: z.string(),
    gitStatus: z.object({
        isGitRepo: z.boolean(),
        defaultBranch: z.string().nullable(),
        lastCommit: z.string().nullable(),
        hasRemote: z.boolean(),
        isDirty: z.boolean(),
    }),
    structure: z.object({
        packages: z.array(z.object({
            path: z.string(),
            name: z.string().nullable(),
            type: z.enum(["app", "library", "tool", "config", "unknown"]),
            language: z.string().nullable(),
        })),
        keyDirectories: z.array(z.string()),
        ignoredPaths: z.array(z.string()),
    }),
    languages: z.array(z.object({
        language: z.string(),
        percentage: z.number(),
        fileCount: z.number(),
        mainFiles: z.array(z.string()),
    })),
});

const CodebaseAnalysis = z.object({
    architecture: z.object({
        pattern: z.string().describe("Overall architectural pattern (MVC, microservices, etc.)"),
        entryPoints: z.array(z.string()),
        mainModules: z.array(z.object({ path: z.string(), purpose: z.string() })),
        dependencies: z.object({
            internal: z.array(z.object({ from: z.string(), to: z.string(), type: z.string() })),
            external: z.record(z.string()),
            keyLibraries: z.array(z.object({ name: z.string(), purpose: z.string(), version: z.string().nullable() })),
        }),
    }),
    codeQuality: z.object({
        hasTests: z.boolean(),
        testCoverage: z.string().nullable(),
        linting: z.array(z.string()),
        formatting: z.array(z.string()),
        documentation: z.object({
            hasReadme: z.boolean(),
            hasApiDocs: z.boolean(),
            codeComments: z.enum(["extensive", "moderate", "minimal", "none"]),
        }),
    }),
    frameworks: z.array(z.object({
        name: z.string(),
        version: z.string().nullable(),
        purpose: z.string(),
        configFiles: z.array(z.string()),
    })),
});

const BuildAndDeployment = z.object({
    buildSystem: z.object({
        type: z.string().nullable(),
        configFiles: z.array(z.string()),
        buildCommands: z.array(z.string()),
        buildAttempts: z.array(z.object({
            command: z.string(),
            success: z.boolean(),
            output: z.string(),
            issues: z.array(z.string()),
        })),
    }),
    packageManagement: z.object({
        managers: z.array(z.string()),
        lockFiles: z.array(z.string()),
        workspaceConfig: z.string().nullable(),
    }),
    testing: z.object({
        frameworks: z.array(z.string()),
        testDirs: z.array(z.string()),
        testCommands: z.array(z.string()),
        testAttempts: z.array(z.object({
            command: z.string(),
            success: z.boolean(),
            output: z.string(),
        })),
    }),
    deployment: z.object({
        cicd: z.array(z.string()),
        dockerfiles: z.array(z.string()),
        deploymentConfigs: z.array(z.string()),
        environmentConfig: z.object({
            envFiles: z.array(z.string()),
            requiredVars: z.array(z.string()),
        }),
    }),
});

const RepoContext = z.object({
    repository: RepositoryStructure,
    codebase: CodebaseAnalysis,
    buildDeploy: BuildAndDeployment,
    insights: z.object({
        complexity: z.enum(["simple", "moderate", "complex", "very-complex"]),
        maturity: z.enum(["prototype", "development", "production", "mature"]),
        maintainability: z.enum(["excellent", "good", "fair", "poor"]),
        recommendations: z.array(z.string()),
        potentialIssues: z.array(z.string()),
        strengthsWeaknesses: z.object({
            strengths: z.array(z.string()),
            weaknesses: z.array(z.string()),
        }),
    }),
    confidence: z.object({
        repository: z.number(),
        codebase: z.number(),
        buildDeploy: z.number(),
        overall: z.number(),
    }),
    executiveSummary: z.string().describe("2-3 paragraph summary as a senior engineer would write"),
});

// Helper to call the Context Agent with comprehensive analysis
async function callContextAgentForAnalysis<T>(
    prompt: string, 
    schema: z.ZodType<T>, 
    maxSteps: number = 50,
    runId?: string,
    logger?: any
): Promise<T> {
    const agent = mastra?.getAgent("contextAgent");
    if (!agent) throw new Error("Context agent not found");
    
    logger?.debug("🤖 Invoking context agent", {
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
    
    logger?.debug("📤 Agent response received", {
        responseLength: text.length,
        duration: `${duration}ms`,
        type: "AGENT_RESPONSE",
        runId: runId,
    });
    
    // Try to extract JSON from response if it's wrapped in markdown or explanatory text
    let jsonText = text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
        jsonText = jsonMatch[1];
        logger?.debug("📋 Extracted JSON from markdown", {
            originalLength: text.length,
            extractedLength: jsonText.length,
            type: "JSON_EXTRACTION",
            runId: runId,
        });
    } else {
        // Look for JSON object boundaries
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            jsonText = text.substring(start, end + 1);
            logger?.debug("📋 Extracted JSON from boundaries", {
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
        
        logger?.debug("✅ JSON parsing and validation successful", {
            jsonLength: jsonText.length,
            validatedKeys: typeof validated === 'object' && validated !== null ? Object.keys(validated as object).length : 0,
            type: "JSON_VALIDATION",
            runId: runId,
        });
        
        return validated;
    } catch (error) {
        logger?.error("❌ JSON parsing or validation failed", {
            error: error instanceof Error ? error.message : 'Unknown error',
            jsonText: jsonText.substring(0, 500), // First 500 chars for debugging
            type: "JSON_ERROR",
            runId: runId,
        });
        
        throw new Error(`JSON parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// Step 1: Comprehensive Repository Analysis
const analyzeRepositoryStep = createStep({
    id: "analyze-repository-step",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        containerId: z.string(),
        repository: RepositoryStructure,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🔍 Starting quick repository scan", {
            step: "1/6", 
            stepName: "Repository Quick Scan",
            containerId,
            approach: "focused and efficient",
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const prompt = `You are a senior software engineer doing a quick repository assessment. Use docker_exec with containerId='${containerId}' efficiently.

TASK: Quick repository overview - focus on the essentials only.

Instructions:
1. Get current directory with 'pwd' for rootPath
2. Quick git check: 'git status' (if it fails, not a git repo)
3. Repository type: Look for workspace indicators (packages/, apps/, pnpm-workspace.yaml, turbo.json) vs single package.json
4. Main language: Check for dominant file types in src/ or root (ls -la, find . -name "*.ts" -o -name "*.js" -o -name "*.py" | head -10)
5. Key structure: Identify 2-3 main directories only (src, lib, app, etc.)

Return strictly JSON - be decisive and quick:
{
  "type": "monorepo" | "single-package" | "multi-project",
  "rootPath": "/path/to/repo",
  "gitStatus": {
    "isGitRepo": boolean,
    "defaultBranch": string | null,
    "lastCommit": string | null,
    "hasRemote": boolean,
    "isDirty": boolean
  },
  "structure": {
    "packages": [{"path": ".", "name": "main", "type": "app", "language": "typescript"}],
    "keyDirectories": ["src", "lib"],
    "ignoredPaths": ["node_modules", ".git", "build", "dist"]
  },
  "languages": [{"language": "typescript", "percentage": 80, "fileCount": 50, "mainFiles": ["index.ts"]}]
}`;
        
        try {
            logger?.info("🤖 Quick repository assessment call", {
                step: "1/6",
                action: "agent-call",
                agentType: "contextAgent",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await callContextAgentForAnalysis(prompt, RepositoryStructure, 15, runId, logger);
            
            logger?.info("✅ Repository scan completed quickly", {
                step: "1/6",
                stepName: "Repository Analysis",
                duration: "completed",
                repositoryType: result.type,
                isGitRepo: result.gitStatus.isGitRepo,
                languageCount: result.languages.length,
                packageCount: result.structure.packages.length,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                repository: result,
            };
        } catch (error) {
            logger?.error("❌ Repository analysis failed", {
                step: "1/6",
                stepName: "Repository Analysis",
                error: error instanceof Error ? error.message : 'Unknown error',
                containerId,
                type: "WORKFLOW",
                runId: runId,
            });

            logger?.warn("🔄 Using fallback repository structure", {
                step: "1/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            // Return minimal fallback structure
            return {
                containerId,
                repository: {
                    type: "single-package" as const,
                    rootPath: "/app",
                    gitStatus: {
                        isGitRepo: false,
                        defaultBranch: null,
                        lastCommit: null,
                        hasRemote: false,
                        isDirty: false,
                    },
                    structure: {
                        packages: [],
                        keyDirectories: [],
                        ignoredPaths: ["node_modules", ".git", "build", "dist", ".next", ".venv", "target"],
                    },
                    languages: [],
                },
            };
        }
    },
});

// Step 2: Deep Codebase Analysis
const analyzeCodebaseStep = createStep({
    id: "analyze-codebase-step",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        containerId: z.string(),
        codebase: CodebaseAnalysis,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("📊 Starting focused codebase scan", {
            step: "2/6",
            stepName: "Codebase Analysis",
            containerId,
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const prompt = `Quick codebase scan for unit testing context using docker_exec with containerId='${containerId}'.

TASK: Essential codebase insights focused on unit test generation needs.

Instructions:
1. Check package.json for key dependencies (cat package.json | grep -E '"(@mastra|react|next|express|fastapi|django|angular|vue|jest|vitest|mocha)"')
2. Look for source files and exports (ls src/ && find src/ -name "*.ts" -o -name "*.js" | head -5)
3. Quick test setup check (ls **/*test* || ls jest.config* || ls vitest.config* || grep -r "describe\\|it\\|test" src/ | head -3)
4. Framework/tool detection for testing strategy (ls next.config* || ls angular.json || ls vite.config*)
5. Check for main exports/functions (grep -r "export.*function\\|export.*class" src/ | head -5)

Return JSON focused on testable components:
{
  "architecture": {
    "pattern": "monolithic",
    "entryPoints": ["src/index.ts"],
    "mainModules": [{"path": "src/mastra", "purpose": "main application logic"}],
    "dependencies": {
      "internal": [],
      "external": {"@mastra/core": "latest"},
      "keyLibraries": [{"name": "mastra", "purpose": "AI framework", "version": "latest"}]
    }
  },
  "codeQuality": {
    "hasTests": false,
    "testCoverage": null,
    "linting": ["typescript"],
    "formatting": [],
    "documentation": {
      "hasReadme": true,
      "hasApiDocs": false,
      "codeComments": "minimal"
    }
  },
  "frameworks": [{"name": "Mastra", "version": "latest", "purpose": "AI workflow framework", "configFiles": ["tsconfig.json"]}]
}`;
        
        try {
            logger?.info("🔬 Quick dependency and framework scan", {
                step: "2/6",
                action: "agent-call",
                agentType: "contextAgent",
                focus: "architecture and dependencies",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await callContextAgentForAnalysis(prompt, CodebaseAnalysis, 15, runId, logger);
            
            logger?.info("✅ Codebase scan completed efficiently", {
                step: "2/6",
                stepName: "Codebase Analysis",
                duration: "completed",
                architecturePattern: result.architecture.pattern,
                entryPointsFound: result.architecture.entryPoints.length,
                frameworksDetected: result.frameworks.length,
                hasTests: result.codeQuality.hasTests,
                keyLibrariesCount: result.architecture.dependencies.keyLibraries.length,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                codebase: result,
            };
        } catch (error) {
            logger?.error("❌ Codebase analysis failed", {
                step: "2/6",
                stepName: "Codebase Analysis",
                error: error instanceof Error ? error.message : 'Unknown error',
                containerId,
                type: "WORKFLOW",
                runId: runId,
            });

            logger?.warn("🔄 Using fallback codebase structure", {
                step: "2/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                codebase: {
                    architecture: {
                        pattern: "unknown",
                        entryPoints: [],
                        mainModules: [],
                        dependencies: {
                            internal: [],
                            external: {},
                            keyLibraries: [],
                        },
                    },
                    codeQuality: {
                        hasTests: false,
                        testCoverage: null,
                        linting: [],
                        formatting: [],
                        documentation: {
                            hasReadme: false,
                            hasApiDocs: false,
                            codeComments: "none" as const,
                        },
                    },
                    frameworks: [],
                },
            };
        }
    },
});

// Step 3: Build and Deployment Analysis
const analyzeBuildDeploymentStep = createStep({
    id: "analyze-build-deployment-step",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        containerId: z.string(),
        buildDeploy: BuildAndDeployment,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId } = inputData;
        const logger = mastra?.getLogger();
        
        logger?.info("🏗️ Starting fast build system scan", {
            step: "3/6",
            stepName: "Build & Deployment Analysis",
            containerId,
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const prompt = `Fast DevOps scan using docker_exec with containerId='${containerId}'.

TASK: Quick build & deployment overview - essentials only.

Instructions:
1. Check package manager: ls *lock* (package-lock.json = npm, yarn.lock = yarn, etc.)
2. Quick scripts check: cat package.json | grep -A5 '"scripts"'
3. CI/CD presence: ls .github/workflows/ || ls .circleci/ 
4. Docker check: ls Dockerfile docker-compose.yml

Return JSON - infer from common patterns:
{
  "buildSystem": {
    "type": "npm",
    "configFiles": ["package.json"],
    "buildCommands": ["npm run build"],
    "buildAttempts": []
  },
  "packageManagement": {
    "managers": ["npm"],
    "lockFiles": ["package-lock.json"],
    "workspaceConfig": null
  },
  "testing": {
    "frameworks": [],
    "testDirs": [],
    "testCommands": [],
    "testAttempts": []
  },
  "deployment": {
    "cicd": [],
    "dockerfiles": [],
    "deploymentConfigs": [],
    "environmentConfig": {
      "envFiles": [],
      "requiredVars": []
    }
  }
}`;
        
        try {
            logger?.info("🚀 Quick build and deployment check", {
                step: "3/6",
                action: "agent-call",
                agentType: "contextAgent",
                focus: "DevOps and deployment",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await callContextAgentForAnalysis(prompt, BuildAndDeployment, 10, runId, logger);
            
            logger?.info("✅ Build system scan completed rapidly", {
                step: "3/6",
                stepName: "Build & Deployment Analysis",
                duration: "completed",
                buildSystemType: result.buildSystem.type,
                packageManagers: result.packageManagement.managers,
                testFrameworks: result.testing.frameworks,
                cicdProviders: result.deployment.cicd,
                buildCommandsCount: result.buildSystem.buildCommands.length,
                buildAttempts: result.buildSystem.buildAttempts.length,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                buildDeploy: result,
            };
        } catch (error) {
            logger?.error("❌ Build and deployment analysis failed", {
                step: "3/6",
                stepName: "Build & Deployment Analysis",
                error: error instanceof Error ? error.message : 'Unknown error',
                containerId,
                type: "WORKFLOW",
                runId: runId,
            });

            logger?.warn("🔄 Using fallback build deployment structure", {
                step: "3/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                buildDeploy: {
                    buildSystem: {
                        type: "unknown" as const,
                        configFiles: [],
                        buildCommands: [],
                        buildAttempts: [],
                    },
                    packageManagement: {
                        managers: [],
                        lockFiles: [],
                        workspaceConfig: null,
                    },
                    testing: {
                        frameworks: [],
                        testDirs: [],
                        testCommands: [],
                        testAttempts: [],
                    },
                    deployment: {
                        cicd: [],
                        dockerfiles: [],
                        deploymentConfigs: [],
                        environmentConfig: {
                            envFiles: [],
                            requiredVars: [],
                        },
                    },
                },
            };
        }
    },
});

// Step 4: Synthesize Final Context  
const synthesizeContextStep = createStep({
    id: "synthesize-context-step",
    inputSchema: z.object({
        "analyze-repository-step": z.object({
            containerId: z.string(),
            repository: RepositoryStructure,
        }),
        "analyze-codebase-step": z.object({
            containerId: z.string(),
            codebase: CodebaseAnalysis,
        }),
        "analyze-build-deployment-step": z.object({
            containerId: z.string(),
            buildDeploy: BuildAndDeployment,
        }),
    }),
    outputSchema: RepoContext.extend({
        containerId: z.string(),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        // Extract results from parallel execution
        const repository = inputData["analyze-repository-step"].repository;
        const codebase = inputData["analyze-codebase-step"].codebase;
        const buildDeploy = inputData["analyze-build-deployment-step"].buildDeploy;
        const containerId = inputData["analyze-repository-step"].containerId;
        const logger = mastra?.getLogger();
        
        logger?.info("🧠 Starting context synthesis and insights generation", {
            step: "4/6",
            stepName: "Context Synthesis",
            repositoryType: repository.type,
            architecturePattern: codebase.architecture.pattern,
            buildSystemType: buildDeploy.buildSystem.type,
            totalDataPoints: {
                packages: repository.structure.packages.length,
                frameworks: codebase.frameworks.length,
                buildCommands: buildDeploy.buildSystem.buildCommands.length,
                testFrameworks: buildDeploy.testing.frameworks.length,
            },
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });
        
        const prompt = `You are a senior technical lead providing an executive summary and insights about a codebase.

Repository Analysis:
${JSON.stringify(repository, null, 2)}

Codebase Analysis:
${JSON.stringify(codebase, null, 2)}

Build & Deployment Analysis:
${JSON.stringify(buildDeploy, null, 2)}

TASK: Synthesize insights and provide executive summary as a senior engineer would.

Instructions:
1. Assess complexity based on architecture, dependencies, and codebase size
2. Determine maturity level based on testing, documentation, and tooling
3. Evaluate maintainability based on code quality, structure, and practices
4. Provide actionable recommendations
5. Identify potential issues and technical debt
6. Highlight strengths and weaknesses
7. Write a professional executive summary (2-3 paragraphs)
8. Assign confidence scores (0-1) for each analysis area

Return strictly JSON matching this schema:
{
  "repository": <repository_data>,
  "codebase": <codebase_data>,
  "buildDeploy": <buildDeploy_data>,
  "insights": {
    "complexity": "simple|moderate|complex|very-complex",
    "maturity": "prototype|development|production|mature",
    "maintainability": "excellent|good|fair|poor",
    "recommendations": ["Add comprehensive tests", "Improve documentation"],
    "potentialIssues": ["Missing error handling", "No type safety"],
    "strengthsWeaknesses": {
      "strengths": ["Modern tech stack", "Good project structure"],
      "weaknesses": ["Limited testing", "No CI/CD pipeline"]
    }
  },
  "confidence": {
    "repository": 0.9,
    "codebase": 0.8,
    "buildDeploy": 0.7,
    "overall": 0.8
  },
  "executiveSummary": "This is a well-structured TypeScript project..."
}`;
        
        try {
            logger?.info("💡 Generating insights and executive summary", {
                step: "4/6",
                action: "agent-call",
                agentType: "contextAgent",
                focus: "technical leadership insights",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await callContextAgentForAnalysis(prompt, RepoContext, 20, runId, logger);
            
            logger?.info("✅ Context synthesis completed successfully", {
                step: "4/6",
                stepName: "Context Synthesis",
                duration: "completed",
                insights: {
                    complexity: result.insights.complexity,
                    maturity: result.insights.maturity,
                    maintainability: result.insights.maintainability,
                    recommendationsCount: result.insights.recommendations.length,
                    potentialIssuesCount: result.insights.potentialIssues.length,
                    strengthsCount: result.insights.strengthsWeaknesses.strengths.length,
                    weaknessesCount: result.insights.strengthsWeaknesses.weaknesses.length,
                },
                confidence: result.confidence,
                type: "WORKFLOW",
                runId: runId,
            });

            return { ...result, containerId };
        } catch (error) {
            logger?.error("❌ Context synthesis failed", {
                step: "4/6",
                stepName: "Context Synthesis",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW",
                runId: runId,
            });

            logger?.warn("🔄 Using fallback insights and summary", {
                step: "4/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                repository,
                codebase,
                buildDeploy,
                insights: {
                    complexity: "moderate" as const,
                    maturity: "development" as const,
                    maintainability: "fair" as const,
                    recommendations: ["Complete the codebase analysis", "Implement proper error handling"],
                    potentialIssues: ["Incomplete analysis due to technical issues"],
                    strengthsWeaknesses: {
                        strengths: ["Project structure is present"],
                        weaknesses: ["Analysis was incomplete due to technical issues"],
                    },
                },
                confidence: {
                    repository: 0.3,
                    codebase: 0.2,
                    buildDeploy: 0.2,
                    overall: 0.2,
                },
                executiveSummary: "Analysis was incomplete due to technical issues during the codebase examination. The repository structure was partially analyzed, but a more thorough investigation would be needed to provide accurate insights and recommendations.",
            };
        }
    },
});

// Step 5: Save Context for Unit Testing
const saveContextStep = createStep({
    id: "save-context-step",
    inputSchema: RepoContext.extend({
        containerId: z.string(),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoContext: RepoContext,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const logger = mastra?.getLogger();
        
        logger?.info("💾 Saving context for unit test generation", {
            step: "5/6",
            stepName: "Save Unit Test Context",
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const { containerId, ...repoContextData } = inputData;
        const parsed = RepoContext.parse(repoContextData);

        // Enhanced context specifically for unit testing
        const unitTestContext = {
            // Core repository information
            metadata: {
                projectName: parsed.repository.structure.packages[0]?.name || "unknown",
                projectType: parsed.repository.type,
                primaryLanguage: parsed.repository.languages[0]?.language || "typescript",
                rootPath: parsed.repository.rootPath,
                isGitRepo: parsed.repository.gitStatus.isGitRepo,
                generatedAt: new Date().toISOString(),
                confidence: parsed.confidence.overall,
            },

            // File structure for test generation
            structure: {
                sourceDirectories: parsed.repository.structure.keyDirectories,
                packages: parsed.repository.structure.packages,
                testingFramework: parsed.buildDeploy.testing.frameworks[0] || "jest",
                entryPoints: parsed.codebase.architecture.entryPoints,
                mainModules: parsed.codebase.architecture.mainModules,
            },

            // Dependencies and frameworks that affect testing
            dependencies: {
                keyLibraries: parsed.codebase.architecture.dependencies.keyLibraries,
                external: parsed.codebase.architecture.dependencies.external,
                frameworks: parsed.codebase.frameworks,
                packageManager: parsed.buildDeploy.packageManagement.managers[0] || "npm",
            },

            // Testing strategy based on architecture
            testingStrategy: {
                architecturePattern: parsed.codebase.architecture.pattern,
                complexity: parsed.insights.complexity,
                hasExistingTests: parsed.codebase.codeQuality.hasTests,
                testCommands: parsed.buildDeploy.testing.testCommands,
                recommendedApproach: parsed.insights.complexity === "simple" ? "unit-focused" : "integration-included",
            },

            // Code quality indicators that affect test design
            codeQuality: {
                hasTypeScript: parsed.repository.languages.some(l => l.language === "typescript"),
                hasLinting: parsed.codebase.codeQuality.linting.length > 0,
                codeComments: parsed.codebase.codeQuality.documentation.codeComments,
                maintainability: parsed.insights.maintainability,
            },

            // Recommendations specific to testing
            testingRecommendations: parsed.insights.recommendations.filter(rec => 
                rec.toLowerCase().includes('test') || 
                rec.toLowerCase().includes('ci') || 
                rec.toLowerCase().includes('error')
            ),

            // Full context for reference
            fullAnalysis: parsed,
        };

        const contextJson = JSON.stringify(unitTestContext, null, 2);
        const contextPath = "/app/agent.context.json";

        try {
            // Use docker_exec to write the context file
            const agent = mastra?.getAgent("contextAgent");
            if (!agent) throw new Error("Context agent not found");

            const writePrompt = `Write the following JSON context to ${contextPath} using docker_exec with containerId='${containerId}'.

TASK: Save unit testing context to file.

Instructions:
1. Use: echo '${contextJson.replace(/'/g, "\\'")}' > ${contextPath}
2. Verify the file was written: ls -la ${contextPath}
3. Return confirmation with file size

Context to write:
${contextJson}`;

            logger?.info("📝 Writing context file to container", {
                step: "5/6",
                action: "write-context",
                path: contextPath,
                sizeBytes: contextJson.length,
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await agent.generate(writePrompt, { maxSteps: 5 });
            
            logger?.info("✅ Context saved successfully for unit testing", {
                step: "5/6",
                stepName: "Save Unit Test Context",
                contextPath,
                contextSize: `${Math.round(contextJson.length / 1024)}KB`,
                testingFocus: {
                    primaryLanguage: unitTestContext.metadata.primaryLanguage,
                    testingFramework: unitTestContext.structure.testingFramework,
                    architecturePattern: unitTestContext.testingStrategy.architecturePattern,
                    recommendedApproach: unitTestContext.testingStrategy.recommendedApproach,
                },
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                contextPath,
                repoContext: parsed,
            };

        } catch (error) {
            logger?.error("❌ Failed to save context file", {
                step: "5/6",
                stepName: "Save Unit Test Context",
                error: error instanceof Error ? error.message : 'Unknown error',
                contextPath,
                type: "WORKFLOW",
                runId: runId,
            });

            // Continue anyway with warning
            logger?.warn("🔄 Continuing without saved context file", {
                step: "5/6",
                action: "continue-without-file",
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                contextPath: "not-saved",
                repoContext: parsed,
            };
        }
    },
});

// Final validation and return step
const validateAndReturnStep = createStep({
    id: "validate-and-return-step",
    inputSchema: z.object({
        containerId: z.string(),
        contextPath: z.string(),
        repoContext: RepoContext,
    }),
    outputSchema: z.object({
        result: z.string(),
        success: z.boolean(),
        toolCallCount: z.number(),
        contextPath: z.string(),
        repoContext: RepoContext,
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const logger = mastra?.getLogger();
        
        logger?.info("🔍 Starting final validation and summary", {
            step: "6/6",
            stepName: "Validation & Summary",
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        try {
            const { containerId, contextPath, repoContext } = inputData;
            const parsed = RepoContext.parse(repoContext);
            
            logger?.info("📋 Workflow execution summary", {
                step: "6/6",
                stepName: "Validation & Summary",
                totalToolCalls: cliToolMetrics.callCount,
                contextSaved: contextPath !== "not-saved",
                contextPath,
                analysis: {
                    repositoryType: parsed.repository.type,
                    gitRepository: parsed.repository.gitStatus.isGitRepo,
                    languagesDetected: parsed.repository.languages.length,
                    packagesFound: parsed.repository.structure.packages.length,
                    architecturePattern: parsed.codebase.architecture.pattern,
                    frameworksDetected: parsed.codebase.frameworks.length,
                    hasTests: parsed.codebase.codeQuality.hasTests,
                    buildSystemType: parsed.buildDeploy.buildSystem.type,
                    cicdProviders: parsed.buildDeploy.deployment.cicd.length,
                    complexity: parsed.insights.complexity,
                    maturity: parsed.insights.maturity,
                    maintainability: parsed.insights.maintainability,
                    recommendationsCount: parsed.insights.recommendations.length,
                    overallConfidence: parsed.confidence.overall,
                },
                type: "WORKFLOW",
                runId: runId,
            });

            logger?.info("✅ Repository context analysis completed successfully", {
                step: "6/6",
                stepName: "Validation & Summary",
                duration: "completed",
                success: true,
                executiveSummaryLength: parsed.executiveSummary.length,
                readyForUnitTests: true,
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                result: "Repository context analysis complete and saved for unit testing",
                success: true,
                toolCallCount: cliToolMetrics.callCount,
                contextPath,
                repoContext: parsed,
            };
        } catch (error) {
            logger?.error("❌ Final validation failed", {
                step: "6/6",
                stepName: "Validation & Summary",
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "WORKFLOW",
                runId: runId,
            });

            throw new Error(`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
});

// Workflow start logging step
const workflowStartStep = createStep({
    id: "workflow-start-step", 
    inputSchema: WorkflowInput,
    outputSchema: WorkflowInput,
    execute: async ({ inputData, mastra, runId }) => {
        const logger = mastra?.getLogger();
        
        logger?.info("🚀 Starting fast repository context workflow", {
            workflowId: "gather-context-workflow",
            workflowName: "Fast Repository Context Analysis",
            containerId: inputData.containerId,
            totalSteps: 6,
            optimized: "for speed and unit test generation",
            startTime: new Date().toISOString(),
            type: "WORKFLOW_START",
            runId: runId,
        });

        logger?.info("📋 Fast workflow execution plan", {
            steps: [
                "1/6: Workflow Start - Log execution plan & setup",
                "2/6: Parallel Analysis - Repository, Codebase & Build scans (concurrent)",
                "3/6: Context Synthesis - Insights and executive summary",
                "4/6: Save Unit Test Context - Write context to agent.context.json",
                "5/6: Validation & Summary - Final validation and results"
            ],
            approach: "parallel execution for 3x speed improvement, optimized for unit test generation",
            estimatedDuration: "15-45 seconds",
            parallelSteps: ["Repository Scan", "Codebase Scan", "Build System Scan"],
            type: "WORKFLOW_PLAN",
            runId: runId,
        });

        return inputData;
    },
});

export const gatherContextWorkflow = createWorkflow({
    id: "gather-context-workflow",
    description: "Ultra-fast parallel repository analysis optimized for unit test generation with context saved to agent.context.json",
    inputSchema: WorkflowInput,
    outputSchema: z.object({
        result: z.string(),
        success: z.boolean(),
        toolCallCount: z.number(),
        contextPath: z.string(),
        repoContext: RepoContext,
    }),
})
.then(workflowStartStep)
.parallel([analyzeRepositoryStep, analyzeCodebaseStep, analyzeBuildDeploymentStep])
.then(synthesizeContextStep)
.then(saveContextStep)
.then(validateAndReturnStep)
.commit();

