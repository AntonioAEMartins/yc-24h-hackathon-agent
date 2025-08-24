import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import { notifyStepStatus } from "../../tools/alert-notifier";
import { cliToolMetrics } from "../../tools/cli-tool";
import { mastra } from "../..";

const ALERTS_ONLY = (process.env.ALERTS_ONLY === 'true') || (process.env.LOG_MODE === 'alerts_only') || (process.env.MASTRA_LOG_MODE === 'alerts_only');

export const runTypescriptVitestCoverageStep = createStep({
    id: "run-typescript-vitest-coverage-step",
    inputSchema: z.object({
        containerId: z.string(),
        projectId: z.string(),
        repoPath: z.string().optional(),
        prUrl: z.string().optional(),
        contextPath: z.string().optional(),
        result: z.string().optional(),
        success: z.boolean().optional(),
        toolCallCount: z.number().optional(),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        projectId: z.string(),
        coverage: z.number(), // 0..1
        repoPath: z.string(),
        language: z.string(),
        framework: z.string(),
        method: z.string(), // 'json' | 'xml' | 'stdout' | 'algorithmic'
        stats: z.object({
            statements: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            branches: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            functions: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            lines: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
        }),
        files: z.number(),
        prUrl: z.string().optional(),
        contextPath: z.string().optional(),
        result: z.string().optional(),
        success: z.boolean(),
        toolCallCount: z.number().optional(),
    }),
    execute: async ({ inputData, runId }) => {
        await notifyStepStatus({
            stepId: "run-typescript-vitest-coverage-step",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Run TypeScript + Vitest coverage",
            subtitle: "Using intelligent agent to validate and calculate coverage",
        });

        const logger = ALERTS_ONLY ? null : mastra.getLogger();
        const agent = mastra.getAgent("typescriptVitestCoverageAgent");
        if (!agent) throw new Error("typescriptVitestCoverageAgent not registered");

        const prompt = `CRITICAL: Analyze this TypeScript + Vitest project for coverage.

Container ID: ${inputData.containerId}
Repo Path Hint: ${inputData.repoPath || 'Not provided - please discover'}

CRITICAL: Node.js may NOT be available in the container. Handle gracefully!

YOUR MISSION:
1. DISCOVER REPOSITORY PATH DYNAMICALLY (works for ANY repository):
   - Search broadly: docker exec ${inputData.containerId} find /app -name "package.json" -type f -not -path "*/node_modules/*" 2>/dev/null | head -1
   - Extract directory: dirname of the found package.json path  
   - If /app search fails, try common container paths: /workspace/, /code/, /src/, /project/, /home/, /usr/src/
   - Verify both package.json AND tsconfig.json exist at discovered path
   - NEVER hardcode repository names - use dynamic discovery

2. Check Node.js availability FIRST:
   - Run: docker exec ${inputData.containerId} which node
   - If "command not found" → Use ALGORITHMIC approach
   - If found → Use standard Vitest approach

3. IF NODE.JS MISSING (likely scenario):
   - Read package.json: docker exec ${inputData.containerId} cat DISCOVERED_REPO_PATH/package.json
   - Manually parse JSON to check for "typescript" and "vitest" in dependencies/devDependencies
   - Count ALL TypeScript files: docker exec ${inputData.containerId} find DISCOVERED_REPO_PATH -name "*.ts" -o -name "*.tsx" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/build/*" | wc -l
   - Count test files ANYWHERE: docker exec ${inputData.containerId} find DISCOVERED_REPO_PATH \\( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" \\) -not -path "*/node_modules/*" | wc -l
   - Calculate: source_files = total_files - test_files, coverage = min(1.0, test_count / max(source_count, 1) * 2.5)
   - IMPORTANT: Tests may be co-located with source files, not in separate test/ folder

4. IF NODE.JS AVAILABLE:
   - Install: docker exec ${inputData.containerId} bash -c "cd DISCOVERED_REPO_PATH && npm ci --no-audit --no-fund"
   - Run: docker exec ${inputData.containerId} bash -c "cd DISCOVERED_REPO_PATH && npx vitest run --coverage"

5. Return ONLY JSON - no explanatory text or markdown!

REQUIRED JSON OUTPUT:
{
  "isValid": boolean,
  "repoPath": string, 
  "language": "TypeScript",
  "framework": "Vitest",
  "coverage": number,
  "method": string,
  "stats": {
    "statements": {"total": number, "covered": number, "pct": number},
    "branches": {"total": number, "covered": number, "pct": number},
    "functions": {"total": number, "covered": number, "pct": number}, 
    "lines": {"total": number, "covered": number, "pct": number}
  },
  "files": number,
  "reason": string
}

BE SPECIFIC: Include exact commands you tried and their outputs in the reason field if anything fails.

CRITICAL: This solution must work for ANY TypeScript + Vitest repository in any container setup - never hardcode paths or repository names!`;

        const result: any = await agent.generate(prompt, { maxSteps: 100, maxRetries: 2 });
        const text = String(result?.text || "{}");
        
        // Extract JSON from response - improved parsing
        let jsonText = "";
        
        // Try to extract from markdown code blocks first
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            jsonText = jsonMatch[1].trim();
        } else {
            // Look for JSON object in the text
            const startIndex = text.indexOf('{');
            const lastIndex = text.lastIndexOf('}');
            if (startIndex !== -1 && lastIndex !== -1 && lastIndex > startIndex) {
                jsonText = text.substring(startIndex, lastIndex + 1);
            } else {
                // Fallback: try to find JSON-like pattern
                const jsonPattern = /\{[\s\S]*"isValid"[\s\S]*\}/;
                const match = text.match(jsonPattern);
                jsonText = match ? match[0] : "{}";
            }
        }
        
        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch (error) {
            logger?.error?.("Failed to parse agent response", { 
                originalText: text, 
                extractedJson: jsonText, 
                error: error 
            });
            
            // If JSON parsing fails, try to create a fallback response
            console.log("JSON parsing failed, attempting fallback parsing...");
            console.log("Original text length:", text.length);
            console.log("Extracted JSON:", jsonText);
            
            throw new Error(`Agent returned invalid JSON response. Extracted: "${jsonText.substring(0, 200)}..."`);
        }

        if (!parsed.isValid) {
            await notifyStepStatus({
                stepId: "run-typescript-vitest-coverage-step",
                status: "completed",
                runId,
                containerId: inputData.containerId,
                title: "Project validation failed",
                subtitle: parsed.reason || "Unknown validation error",
                toolCallCount: cliToolMetrics.callCount,
            });

            throw new Error(`Invalid project for TypeScript + Vitest coverage: ${parsed.reason}`);
        }

        const coverage = Math.max(0, Math.min(1, Number(parsed.coverage) || 0));
        
        logger?.info?.("TypeScript + Vitest coverage analysis completed", { 
            coverage, 
            method: parsed.method, 
            files: parsed.files,
            repoPath: parsed.repoPath 
        });

        await notifyStepStatus({
            stepId: "run-typescript-vitest-coverage-step",
            status: "completed",
            runId,
            containerId: inputData.containerId,
            title: "TypeScript + Vitest coverage calculated",
            subtitle: `${(coverage * 100).toFixed(2)}% via ${parsed.method} (${parsed.files} files)`,
            toolCallCount: cliToolMetrics.callCount,
        });

        return {
            containerId: inputData.containerId,
            projectId: inputData.projectId,
            coverage,
            repoPath: parsed.repoPath,
            language: "TypeScript",
            framework: "Vitest",
            method: parsed.method,
            stats: parsed.stats || {
                statements: { total: 0, covered: 0, pct: coverage * 100 },
                branches: { total: 0, covered: 0, pct: 0 },
                functions: { total: 0, covered: 0, pct: 0 },
                lines: { total: 0, covered: 0, pct: coverage * 100 },
            },
            files: parsed.files || 0,
            prUrl: inputData.prUrl,
            contextPath: inputData.contextPath,
            result: inputData.result,
            success: true,
            toolCallCount: inputData.toolCallCount,
        };
    },
});

export const postTestCoverageStep = createStep({
    id: "post-test-coverage-step",
    inputSchema: z.object({
        containerId: z.string(),
        projectId: z.string(),
        coverage: z.number(),
        repoPath: z.string(),
        language: z.string(),
        framework: z.string(),
        method: z.string(),
        stats: z.object({
            statements: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            branches: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            functions: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            lines: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
        }),
        files: z.number(),
        prUrl: z.string().optional(),
        contextPath: z.string().optional(),
        result: z.string().optional(),
        success: z.boolean(),
        toolCallCount: z.number().optional(),
    }),
    outputSchema: z.object({
        containerId: z.string(),
        projectId: z.string(),
        coverage: z.number(),
        language: z.string(),
        framework: z.string(),
        method: z.string(),
        stats: z.object({
            statements: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            branches: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            functions: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            lines: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
        }),
        files: z.number(),
        prUrl: z.string().optional(),
        contextPath: z.string().optional(),
        result: z.string().optional(),
        success: z.boolean(),
        toolCallCount: z.number().optional(),
    }),
    execute: async ({ inputData, runId }) => {
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const url = `${baseUrl}/api/projects/${inputData.projectId}/test-coverage`;

        await notifyStepStatus({
            stepId: "post-test-coverage-step",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Post TypeScript + Vitest coverage",
            subtitle: `${(inputData.coverage * 100).toFixed(2)}% (${inputData.method}) → ${url}`,
        });

        const payload = {
            coverage: inputData.coverage,
            language: inputData.language,
            framework: inputData.framework,
            method: inputData.method,
            stats: inputData.stats,
            files: inputData.files,
        };

        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch {}

        await notifyStepStatus({
            stepId: "post-test-coverage-step",
            status: "completed",
            runId,
            containerId: inputData.containerId,
            title: "TypeScript + Vitest coverage posted",
            subtitle: `${(inputData.coverage * 100).toFixed(2)}% (${inputData.files} files, ${inputData.method} method)`,
            toolCallCount: cliToolMetrics.callCount,
        });

        return inputData;
    },
});

export const typescriptVitestCoverageWorkflow = createWorkflow({
    id: "typescript-vitest-coverage-workflow",
    description: "Calculate TypeScript + Vitest test coverage using algorithms/statistics and POST to backend",
    inputSchema: z.object({
        containerId: z.string(),
        projectId: z.string(),
        repoPath: z.string().optional(),
    }),
    outputSchema: z.object({
        coverage: z.number(),
        projectId: z.string(),
        language: z.string(),
        framework: z.string(),
        method: z.string(),
        files: z.number(),
        stats: z.object({
            statements: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            branches: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            functions: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
            lines: z.object({
                total: z.number(),
                covered: z.number(),
                pct: z.number(),
            }),
        }),
    }),
})
.then(runTypescriptVitestCoverageStep as any)
.then(postTestCoverageStep as any)
.commit();

// Keep the old workflow for backward compatibility
export const testCoverageWorkflow = typescriptVitestCoverageWorkflow;

