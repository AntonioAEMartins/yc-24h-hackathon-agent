import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";
import { exec } from "child_process";
import { existsSync, writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { notifyStepStatus } from "../../tools/alert-notifier";

const ALERTS_ONLY = (process.env.ALERTS_ONLY === 'true') || (process.env.LOG_MODE === 'alerts_only') || (process.env.MASTRA_LOG_MODE === 'alerts_only');

export const testDockerStep = createStep({
    id: "test-docker-step",
    inputSchema: z.object({
        contextData: z.any().optional().describe("Optional context data to pass through"),
        repositoryUrl: z.string().optional().describe("Optional repository URL or owner/repo format (e.g., 'owner/repo' or 'https://github.com/owner/repo')"),
        projectId: z.string().describe("Project ID associated with this workflow run"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
        repositoryUrl: z.string().optional().describe("Repository URL passed through"),
        projectId: z.string().describe("Project ID passed through"),
    }),
    execute: async ({ inputData, runId }) => {
        await notifyStepStatus({
            stepId: "test-docker-step",
            status: "starting",
            runId,
            title: "Docker setup",
            subtitle: "Building image and starting container",
            metadata: { contextDataPresent: !!inputData.contextData }
        });

        const logger = ALERTS_ONLY ? null : mastra?.getLogger();

        function sh(cmd: string): Promise<string> {
            return new Promise((resolve, reject) => {
                exec(cmd, (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                    } else {
                        resolve(stdout);
                    }
                });
            });
        }

        try {
            // Build minimal image
            const buildCmd = `docker build -t yc-ubuntu:22.04 -<<'EOF'
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
CMD ["bash"]
EOF`;
            logger?.info("🐳 Building Docker image yc-ubuntu:22.04", { type: "DOCKER", runId });
            await sh(buildCmd);

            // Remove any existing container to avoid conflicts
            await sh("docker rm -f yc-ubuntu-test || true");

            // Run container detached
            logger?.info("🚀 Starting container yc-ubuntu-test", { type: "DOCKER", runId });
            await sh("docker run -d --name yc-ubuntu-test yc-ubuntu:22.04 tail -f /dev/null");

            // Get container ID
            const inspectOut = await sh("docker inspect -f '{{.Id}}' yc-ubuntu-test");
            const containerId = (inspectOut || "").trim();

            await notifyStepStatus({
                stepId: "test-docker-step",
                status: "completed",
                runId,
                containerId,
                title: "Docker setup completed",
                subtitle: `Container ready (${containerId.substring(0,12)})`,
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                result: inspectOut || "Operation completed",
                success: true,
                toolCallCount: cliToolMetrics.callCount,
                containerId,
                contextData: inputData.contextData,
                repositoryUrl: inputData.repositoryUrl,
                projectId: inputData.projectId,
            };
        } catch (error) {
            await notifyStepStatus({
                stepId: "test-docker-step",
                status: "failed",
                runId,
                title: "Docker setup failed",
                subtitle: error instanceof Error ? error.message : 'Unknown error',
                level: 'error',
            });
            throw error;
        }
    }
});

export const testDockerGithubCloneStep = createStep({
    id: "test-docker-github-clone-step",
    inputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
        repositoryUrl: z.string().optional().describe("Repository URL passed through"),
        projectId: z.string().describe("Project ID passed through"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
        repositoryUrl: z.string().optional().describe("Repository URL passed through"),
        projectId: z.string().describe("Project ID passed through"),
        repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    }),
    execute: async ({ inputData, runId }) => {
        await notifyStepStatus({
            stepId: "test-docker-github-clone-step",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Cloning repository",
            subtitle: "Preparing to clone repo into container",
        });
        return await new Promise((resolve, reject) => {
            // Copy PAT into container and use it to clone the repo, then remove the file
            const cwd = process.cwd();
            let credentialsPath = path.resolve(cwd, ".docker.credentials");
            const fallbackPath = path.resolve(cwd, "..", "..", ".docker.credentials");
            if (!existsSync(credentialsPath) && existsSync(fallbackPath)) {
                credentialsPath = fallbackPath;
            }
            if (!existsSync(credentialsPath)) {
                reject(new Error(`.docker.credentials not found. Checked: ${credentialsPath}`));
                return;
            }

            // Determine repository coordinates - prioritize manual input, then contextData, then default
            let resolvedRepoPath: string;
            let repoOwner: string | undefined;
            let repoName: string | undefined;
            
            // First, check for manually provided repository URL
            if (inputData.repositoryUrl) {
                const repoUrl = inputData.repositoryUrl.trim();
                
                // Handle different formats: "owner/repo", "https://github.com/owner/repo", "https://github.com/owner/repo.git"
                if (repoUrl.includes('github.com/')) {
                    // Extract from full GitHub URL
                    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
                    if (match) {
                        repoOwner = match[1];
                        repoName = match[2];
                        resolvedRepoPath = `${repoOwner}/${repoName}`;
                    } else {
                        throw new Error(`Invalid GitHub URL format: ${repoUrl}`);
                    }
                } else if (repoUrl.includes('/') && !repoUrl.includes(' ')) {
                    // Handle "owner/repo" format
                    const [ownerPart, repoPart] = repoUrl.split('/');
                    if (ownerPart && repoPart) {
                        repoOwner = ownerPart;
                        repoName = repoPart;
                        resolvedRepoPath = repoUrl;
                    } else {
                        throw new Error(`Invalid repository format: ${repoUrl}. Expected format: "owner/repo"`);
                    }
                } else {
                    throw new Error(`Invalid repository format: ${repoUrl}. Expected format: "owner/repo" or GitHub URL`);
                }
            } else {
                // Fall back to contextData extraction
                const context: any = (inputData as any)?.contextData || {};
                repoOwner = typeof context.owner === 'string' ? context.owner : undefined;
                repoName = typeof context.repo === 'string' ? context.repo : undefined;
                const fullName: string | undefined = typeof context.fullName === 'string' ? context.fullName : (typeof context.full_name === 'string' ? context.full_name : undefined);
                if ((!repoOwner || !repoName) && fullName && fullName.includes('/')) {
                    const [ownerPart, repoPart] = fullName.split('/');
                    repoOwner = repoOwner || ownerPart;
                    repoName = repoName || repoPart;
                }
                resolvedRepoPath = (repoOwner && repoName) ? `${repoOwner}/${repoName}` : 'AntonioAEMartins/yc-24h-hackathon-agent';
            }
            // Get default branch from contextData
            const context: any = (inputData as any)?.contextData || {};
            const defaultBranch: string | undefined = typeof context.defaultBranch === 'string' ? context.defaultBranch : (typeof context.default_branch === 'string' ? context.default_branch : undefined);
            const branchArg = defaultBranch ? ` --branch ${defaultBranch} ` : ' ';

            // Compute expected repo path in the container
            const inferredRepoName = (repoName && typeof repoName === 'string')
                ? repoName.replace(/\.git$/, '')
                : 'yc-24h-hackathon-agent';
            const inferredRepoPath = `/app/${inferredRepoName}`;

            // First, copy the credentials file to the container
            const copyCmd = `docker cp "${credentialsPath}" ${inputData.containerId}:/root/.docker.credentials`;
            
            exec(copyCmd, (copyError, copyStdout, copyStderr) => {
                if (copyError) {
                    reject(new Error(`Failed to copy credentials file: ${copyStderr || copyError.message}`));
                    return;
                }

                // Verify the file was copied successfully
                const verifyCmd = `docker exec ${inputData.containerId} test -f /root/.docker.credentials`;
                
                exec(verifyCmd, (verifyError, verifyStdout, verifyStderr) => {
                    if (verifyError) {
                        reject(new Error(`Credentials file not found in container after copy: ${verifyStderr || verifyError.message}`));
                        return;
                    }

                    // Now execute the git clone command with dynamic repo and optional branch
                    const execCmd = `docker exec ${inputData.containerId} bash -c "set -e; TOKEN=\\$(grep GITHUB_PAT /root/.docker.credentials | cut -d'=' -f2 | tr -d '[:space:]'); if ( [ -z \"\\\$TOKEN\" ] ); then echo 'Error: GITHUB_PAT not found or empty in credentials file'; exit 1; fi; cd /app; git clone${branchArg}https://x-access-token:\\$TOKEN@github.com/${resolvedRepoPath}.git; rm -f /root/.docker.credentials; echo 'Repository cloned successfully'"`;
                    
                    exec(execCmd, (execError, execStdout, execStderr) => {
                        if (execError) {
                            reject(new Error(`Git clone failed: ${execStderr || execError.message}`));
                        } else {
                            notifyStepStatus({
                                stepId: "test-docker-github-clone-step",
                                status: "completed",
                                runId,
                                containerId: inputData.containerId,
                                title: "Repository cloned",
                                subtitle: "Repository cloned successfully",
                                toolCallCount: cliToolMetrics.callCount,
                            });
                            resolve({
                                result: execStdout,
                                success: true,
                                toolCallCount: cliToolMetrics.callCount,
                                containerId: inputData.containerId,
                                contextData: inputData.contextData,
                                repositoryUrl: inputData.repositoryUrl,
                                projectId: inputData.projectId,
                                repoPath: inferredRepoPath,
                            });
                        }
                    });
                });
            });
        });
    }
});

// Step: Post project description to backend
export const postProjectDescriptionStep = createStep({
    id: "post-project-description-step",
    inputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
        repositoryUrl: z.string().optional().describe("Repository URL passed through"),
        projectId: z.string().describe("Project ID passed through"),
        repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
        repositoryUrl: z.string().optional().describe("Repository URL passed through"),
        projectId: z.string().describe("Project ID passed through"),
        repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        await notifyStepStatus({
            stepId: "post-project-description-step",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Post project description",
            subtitle: "Posting description to backend",
        });

        // Extract projectId from inputData (now passed directly)
        const context: any = inputData.contextData || {};
        const projectId = inputData.projectId;

        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const descriptionUrl = `${baseUrl}/api/projects/${projectId}/description`;

        // Build project description using a dedicated agent first; fall back to static heuristics
        const containerId = inputData.containerId;
        const repoPath = (inputData as any).repoPath || "/app";

        const sh = (cmd: string): Promise<string> => {
            return new Promise((resolve, reject) => {
                exec(`docker exec ${containerId} bash -lc ${JSON.stringify(cmd)}`, (error, stdout, stderr) => {
                    if (error) reject(new Error(stderr || error.message));
                    else resolve(stdout);
                });
            });
        };

        const getCredToken = (): string | undefined => {
            try {
                const cwd = process.cwd();
                const primaryPath = path.resolve(cwd, '.docker.credentials');
                const fallbackPath = path.resolve(cwd, '..', '..', '.docker.credentials');
                const credPath = existsSync(primaryPath) ? primaryPath : (existsSync(fallbackPath) ? fallbackPath : undefined);
                if (!credPath) return undefined;
                const raw = readFileSync(credPath, 'utf8');
                const m = raw.match(/GITHUB_PAT\s*=\s*(.+)/);
                return m ? m[1].trim() : undefined;
            } catch {
                return undefined;
            }
        };

        const parseOwnerRepo = (): { owner?: string; repo?: string } => {
            let owner: string | undefined;
            let repo: string | undefined;
            const url = (inputData as any).repositoryUrl as string | undefined;
            if (url) {
                if (url.includes('github.com/')) {
                    const match = url.match(/github\.com\/([^\/]+)\/([^\/.]+)/);
                    if (match) { owner = match[1]; repo = match[2]; }
                } else if (url.includes('/') && !url.includes(' ')) {
                    const parts = url.split('/');
                    if (parts.length >= 2) { owner = parts[0]; repo = parts[1]; }
                }
            }
            if (!owner || !repo) {
                const ctxOwner = typeof context.owner === 'string' ? context.owner : undefined;
                const ctxRepo = typeof context.repo === 'string' ? context.repo : undefined;
                const fullName: string | undefined = typeof context.fullName === 'string' ? context.fullName : (typeof context.full_name === 'string' ? context.full_name : undefined);
                if (ctxOwner && ctxRepo) { owner = ctxOwner; repo = ctxRepo; }
                else if (fullName && fullName.includes('/')) { const [o, r] = fullName.split('/'); owner = o; repo = r; }
            }
            return { owner, repo };
        };

        const fetchGithubAbout = async (): Promise<{ about?: string; topics?: string[] }> => {
            try {
                const { owner, repo } = parseOwnerRepo();
                if (!owner || !repo) return {};
                const token = getCredToken();
                const headers: any = { 'Accept': 'application/vnd.github+json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
                if (!res.ok) return {};
                const json: any = await res.json();
                const topics = Array.isArray(json?.topics) ? json.topics : undefined;
                return { about: typeof json?.description === 'string' ? json.description : undefined, topics };
            } catch { return {}; }
        };

        const tryReadme = async (): Promise<string | undefined> => {
            try {
                const findCmd = `cd ${JSON.stringify(repoPath)} && for f in README README.md README.rst README.txt readme.md Readme.md; do if [ -f \"$f\" ]; then echo \"$f\"; break; fi; done`;
                const p = (await sh(findCmd)).trim();
                if (!p) return undefined;
                const filePath = `${repoPath}/${p}`;
                const content = await sh(`sed -n '1,200p' ${JSON.stringify(filePath)}`);
                return content.trim();
            } catch { return undefined; }
        };

        const tryPackageJson = async (): Promise<{ name?: string; description?: string; keywords?: string[] } | undefined> => {
            try {
                const pjPath = `${repoPath}/package.json`;
                const exists = (await sh(`test -f ${JSON.stringify(pjPath)} && echo EXISTS || echo MISSING`)).trim();
                if (exists !== 'EXISTS') return undefined;
                const raw = await sh(`cat ${JSON.stringify(pjPath)}`);
                const json = JSON.parse(raw);
                return { name: json?.name, description: json?.description, keywords: Array.isArray(json?.keywords) ? json.keywords : undefined };
            } catch { return undefined; }
        };

        const analyzeStructure = async (): Promise<{ languages: string[]; features: string[] }> => {
            const features: string[] = [];
            const languages: string[] = [];
            try {
                const filesOut = await sh(`cd ${JSON.stringify(repoPath)} && (git ls-files || find . -type f)`);
                const lines = filesOut.split('\n').map(l => l.trim()).filter(Boolean);
                const counts: Record<string, number> = {};
                for (const lf of lines) {
                    const name = lf.toLowerCase();
                    if (name.includes('node_modules')) continue;
                    const m = name.match(/\.([a-z0-9]+)$/);
                    const ext = m ? m[1] : '';
                    const map: Record<string, string> = {
                        'ts': 'TypeScript', 'tsx': 'TypeScript', 'js': 'JavaScript', 'jsx': 'JavaScript',
                        'py': 'Python', 'rb': 'Ruby', 'go': 'Go', 'rs': 'Rust', 'java': 'Java', 'kt': 'Kotlin',
                        'c': 'C', 'cpp': 'C++', 'cc': 'C++', 'cxx': 'C++', 'hpp': 'C++', 'mm': 'Objective-C',
                        'php': 'PHP', 'swift': 'Swift', 'm': 'Objective-C', 'scala': 'Scala',
                        'html': 'HTML', 'css': 'CSS', 'scss': 'SCSS', 'sass': 'Sass', 'md': 'Markdown', 'sh': 'Shell'
                    };
                    const lang = map[ext];
                    if (lang) counts[lang] = (counts[lang] || 0) + 1;
                }
                const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([k]) => k);
                languages.push(...sorted.slice(0, 5));

                const configs: Array<{ path: string; feat: string }> = [
                    { path: `${repoPath}/Dockerfile`, feat: 'Dockerized' },
                    { path: `${repoPath}/docker-compose.yml`, feat: 'Docker Compose' },
                    { path: `${repoPath}/next.config.js`, feat: 'Next.js' },
                    { path: `${repoPath}/tailwind.config.js`, feat: 'Tailwind CSS' },
                    { path: `${repoPath}/vite.config.ts`, feat: 'Vite' },
                    { path: `${repoPath}/jest.config.js`, feat: 'Jest' },
                    { path: `${repoPath}/vitest.config.ts`, feat: 'Vitest' },
                    { path: `${repoPath}/prisma/schema.prisma`, feat: 'Prisma' },
                ];
                for (const c of configs) {
                    const ex = (await sh(`test -e ${JSON.stringify(c.path)} && echo EXISTS || echo MISSING`)).trim();
                    if (ex === 'EXISTS') features.push(c.feat);
                }
            } catch {}
            return { languages, features };
        };

        // 1) Try agent-driven description
        let finalDescription: string | undefined;
        try {
            const aboutInfo = await fetchGithubAbout();
            const agent = mastra?.getAgent?.("codebaseDescriptionAgent");
            if (agent) {
                const ownerRepo = parseOwnerRepo();
                const hints = {
                    owner: ownerRepo.owner || null,
                    repo: ownerRepo.repo || null,
                    githubAbout: aboutInfo.about || null,
                    githubTopics: aboutInfo.topics || [],
                };
                const prompt = `You have access to docker_exec. containerId='${containerId}'. Repo path hint='${repoPath}'.
Your task: produce a crisp 1-3 sentence description for this repository.
Start by checking obvious sources (README, package manifests). Then, if needed, sample a few representative source files.
Do not read more than 8 content files total. Keep outputs small using head and grep. Use only standard shell tools.
Hints: ${JSON.stringify(hints)}.

When done, return STRICT JSON only: {"description": string, "sources": string[], "confidence": number, "notes": string}.`;
                const res: any = await agent.generate(prompt, { maxSteps: 12, maxRetries: 2 });
                const text: string = (res?.text || "").toString();
                let jsonText = text;
                const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1];
                } else {
                    const s = text.indexOf('{');
                    const e = text.lastIndexOf('}');
                    if (s !== -1 && e !== -1 && e > s) jsonText = text.substring(s, e + 1);
                }
                try {
                    const parsed = JSON.parse(jsonText);
                    if (parsed && typeof parsed.description === 'string' && parsed.description.trim().length > 0) {
                        finalDescription = String(parsed.description).replace(/\s+/g, ' ').trim();
                        logger?.info("🧠 Description agent success", {
                            preview: finalDescription.substring(0, 140),
                            confidence: parsed.confidence,
                            sourcesCount: Array.isArray(parsed.sources) ? parsed.sources.length : 0,
                            type: "AGENT_DESCRIPTION",
                            runId,
                        });
                    }
                } catch (e) {
                    logger?.warn("⚠️ Agent JSON parse failed; will use fallback", { error: e instanceof Error ? e.message : String(e), type: "AGENT_DESCRIPTION", runId });
                }
            }
        } catch (e) {
            logger?.warn("⚠️ Agent invocation failed; will use fallback", { error: e instanceof Error ? e.message : String(e), type: "AGENT_DESCRIPTION", runId });
        }

        // 2) Fallback to static heuristics if needed
        if (!finalDescription) {
            const repoName = context.repo || context.name || (String(repoPath).split('/').pop() || 'repository');
            const [aboutInfo, readmeContent, pkgInfo, structure] = await Promise.all([
                fetchGithubAbout(),
                tryReadme(),
                tryPackageJson(),
                analyzeStructure(),
            ]);

            const primary = aboutInfo.about || pkgInfo?.description || undefined;
            let synthesized: string;
            if (primary) {
                synthesized = primary.trim();
            } else if (readmeContent) {
                const cleaned = readmeContent
                    .split('\n')
                    .filter(line => !/\!\[[^\]]*\]\([^)]*\)/.test(line))
                    .join('\n');
                const paras = cleaned.split(/\n\s*\n/).map(s => s.replace(/^#+\s*/,'').trim()).filter(Boolean);
                synthesized = (paras[1] || paras[0] || `Repository ${repoName}`).slice(0, 600);
            } else {
                const langStr = (structure.languages || []).slice(0,3).join(', ');
                const featStr = (structure.features || []).slice(0,3).join(', ');
                const first = langStr ? `A ${langStr} codebase.` : `A software project.`;
                const secondParts: string[] = [];
                if (featStr) secondParts.push(`Includes ${featStr}.`);
                if (aboutInfo.topics && aboutInfo.topics.length) secondParts.push(`Topics: ${aboutInfo.topics.slice(0,3).join(', ')}.`);
                synthesized = `${first} ${secondParts.join(' ')}`.trim();
            }
            finalDescription = synthesized.replace(/\s+/g, ' ').trim();
        }

        const payload = { description: finalDescription };

        logger?.info("📨 Preparing to post project description", {
            step: "post-project-description",
            url: descriptionUrl,
            projectId,
            hasContextData: !!inputData.contextData,
            contextKeys: Object.keys(context || {}),
            descriptionPreview: (finalDescription || '').substring(0, 120),
            type: "BACKEND_POST",
            runId,
        });

        try {
            logger?.debug("🔗 HTTP request details", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                url: descriptionUrl,
                payload,
                type: "HTTP_REQUEST",
                runId,
            });
            const res = await fetch(descriptionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const success = res.ok;
            logger?.info("📥 Backend responded for project description", {
                status: res.status,
                ok: res.ok,
                url: descriptionUrl,
                projectId,
                type: "BACKEND_RESPONSE",
                runId,
            });
            if (!success) {
                const text = await res.text().catch(() => '');
                logger?.warn("⚠️  Backend responded non-2xx for description", { 
                    url: descriptionUrl, 
                    status: res.status, 
                    payload,
                    responseText: text.substring(0, 500), 
                    type: "BACKEND_POST", 
                    runId 
                });
            }

            await notifyStepStatus({
                stepId: "post-project-description-step",
                status: success ? "completed" : "failed",
                runId,
                containerId: inputData.containerId,
                title: success ? "Description posted" : "Description post failed",
                subtitle: success ? `Posted to project ${projectId}` : "Failed to post description",
            });

        } catch (err) {
            logger?.warn("⚠️  Failed to POST description", { 
                url: descriptionUrl,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                type: "BACKEND_POST",
                runId 
            });

            await notifyStepStatus({
                stepId: "post-project-description-step",
                status: "failed",
                runId,
                containerId: inputData.containerId,
                title: "Description post failed",
                subtitle: "Network error",
            });
        }

        return {
            ...inputData,
            repositoryUrl: inputData.repositoryUrl,
            projectId: inputData.projectId,
        };
    },
});

// Step: Post project tech stack to backend
export const postProjectStackStep = createStep({
    id: "post-project-stack-step",
    inputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
        repositoryUrl: z.string().optional().describe("Repository URL passed through"),
        projectId: z.string().describe("Project ID passed through"),
        repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextData: z.any().optional().describe("Context data passed through"),
        repositoryUrl: z.string().optional().describe("Repository URL passed through"),
        projectId: z.string().describe("Project ID passed through"),
        repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        await notifyStepStatus({
            stepId: "post-project-stack-step",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Post project stack",
            subtitle: "Posting tech stack to backend",
        });

        // Extract projectId from inputData (now passed directly)
        const context: any = inputData.contextData || {};
        const projectId = inputData.projectId;

        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const stackUrl = `${baseUrl}/api/projects/${projectId}/stack`;

        // Enhanced detection using GitHub API + local file analysis and expanded icon mapping
        const normalizeName = (name: string): string => name.toLowerCase().replace(/@/g, '').replace(/[^a-z0-9+\-.]/g, '');

        const stackMap: Record<string, { icon: string; title: string; description: string }> = {
            // Languages
            'typescript': { icon: 'ts', title: 'TypeScript', description: 'Typed superset of JavaScript that compiles to plain JS.' },
            'javascript': { icon: 'js', title: 'JavaScript', description: 'High-level, dynamic language for the web and Node.js.' },
            'python': { icon: 'py', title: 'Python', description: 'Versatile language for scripting, data, and backend services.' },
            'go': { icon: 'go', title: 'Go', description: 'Compiled language for fast, concurrent services by Google.' },
            'rust': { icon: 'rust', title: 'Rust', description: 'Memory-safe systems programming language.' },
            'java': { icon: 'java', title: 'Java', description: 'General-purpose language for enterprise applications.' },
            'c++': { icon: 'cpp', title: 'C++', description: 'High-performance systems and application language.' },
            'c': { icon: 'c', title: 'C', description: 'Low-level systems programming language.' },
            'c#': { icon: 'cs', title: 'C#', description: 'Modern language for .NET platforms.' },
            'php': { icon: 'php', title: 'PHP', description: 'Scripting language for server-side web development.' },
            'ruby': { icon: 'ruby', title: 'Ruby', description: 'Dynamic language focused on simplicity and productivity.' },
            'kotlin': { icon: 'kotlin', title: 'Kotlin', description: 'Modern JVM language by JetBrains.' },
            'swift': { icon: 'swift', title: 'Swift', description: 'Apple’s language for iOS and macOS development.' },
            'scala': { icon: 'scala', title: 'Scala', description: 'JVM language blending OOP and functional programming.' },
            'shell': { icon: 'bash', title: 'Shell', description: 'Shell scripting for automation.' },
            'html': { icon: 'html', title: 'HTML', description: 'Markup language for web pages.' },
            'css': { icon: 'css', title: 'CSS', description: 'Stylesheet language for web pages.' },
            'scss': { icon: 'sass', title: 'SCSS', description: 'Sass syntax for CSS with variables and nesting.' },
            'sass': { icon: 'sass', title: 'Sass', description: 'CSS preprocessor with powerful features.' },

            // JS frameworks/tools
            'next': { icon: 'nextjs', title: 'Next.js', description: 'React framework for hybrid rendering (SSR/SSG) and routing by Vercel.' },
            'nextjs': { icon: 'nextjs', title: 'Next.js', description: 'React framework for hybrid rendering (SSR/SSG) and routing by Vercel.' },
            'react': { icon: 'react', title: 'React', description: 'Component-based UI library for building interactive interfaces.' },
            'vue': { icon: 'vue', title: 'Vue.js', description: 'Progressive framework for building user interfaces.' },
            'svelte': { icon: 'svelte', title: 'Svelte', description: 'Compiler-based UI framework for minimal runtime.' },
            'vite': { icon: 'vite', title: 'Vite', description: 'Next-gen frontend tooling with fast dev server and build.' },
            'vitest': { icon: 'vitest', title: 'Vitest', description: 'Vite-native unit test framework with Jest-compatible API.' },
            'jest': { icon: 'jest', title: 'Jest', description: 'Delightful JavaScript testing framework.' },
            'tailwind': { icon: 'tailwind', title: 'Tailwind CSS', description: 'Utility-first CSS framework for rapid UI development.' },
            'express': { icon: 'express', title: 'Express', description: 'Minimal and flexible Node.js web application framework.' },
            'nestjs': { icon: 'nestjs', title: 'NestJS', description: 'Progressive Node.js framework for scalable server-side apps.' },
            'graphql': { icon: 'graphql', title: 'GraphQL', description: 'Query language for APIs and runtime for fulfilling queries.' },
            'prisma': { icon: 'prisma', title: 'Prisma', description: 'Type-safe ORM for Node.js and TypeScript.' },
            'sequelize': { icon: 'sequelize', title: 'Sequelize', description: 'Promise-based Node.js ORM for Postgres, MySQL, etc.' },
            'redux': { icon: 'redux', title: 'Redux', description: 'Predictable state container for JavaScript apps.' },
            'webpack': { icon: 'webpack', title: 'Webpack', description: 'Module bundler for JavaScript applications.' },
            'rollup': { icon: 'rollupjs', title: 'Rollup', description: 'Module bundler for JavaScript libraries.' },
            'eslint': { icon: 'js', title: 'ESLint', description: 'Pluggable linting utility for JavaScript and TypeScript.' },

            // Python
            'fastapi': { icon: 'fastapi', title: 'FastAPI', description: 'High performance Python web framework for APIs.' },
            'flask': { icon: 'flask', title: 'Flask', description: 'Lightweight WSGI web application framework.' },
            'django': { icon: 'django', title: 'Django', description: 'High-level Python web framework.' },
            'pytorch': { icon: 'pytorch', title: 'PyTorch', description: 'Deep learning framework.' },
            'tensorflow': { icon: 'tensorflow', title: 'TensorFlow', description: 'End-to-end open source platform for machine learning.' },
            'sklearn': { icon: 'sklearn', title: 'Scikit-learn', description: 'Machine learning in Python.' },

            // Infra / DB / Messaging
            'docker': { icon: 'docker', title: 'Docker', description: 'Containerization platform.' },
            'kubernetes': { icon: 'kubernetes', title: 'Kubernetes', description: 'Container orchestration system.' },
            'terraform': { icon: 'terraform', title: 'Terraform', description: 'Infrastructure as code tool.' },
            'postgres': { icon: 'postgres', title: 'PostgreSQL', description: 'Advanced open source relational database.' },
            'sqlite': { icon: 'sqlite', title: 'SQLite', description: 'Serverless SQL database engine.' },
            'mongodb': { icon: 'mongodb', title: 'MongoDB', description: 'NoSQL document database.' },
            'redis': { icon: 'redis', title: 'Redis', description: 'In-memory data store for caching and messaging.' },
            'rabbitmq': { icon: 'rabbitmq', title: 'RabbitMQ', description: 'Message broker for distributed systems.' },
            'elasticsearch': { icon: 'elasticsearch', title: 'Elasticsearch', description: 'Search and analytics engine.' },
            'nginx': { icon: 'nginx', title: 'Nginx', description: 'High performance HTTP and reverse proxy server.' },
        };

        const mapToStackItem = (name: string): { title: string; description: string; icon: string } | null => {
            const n = normalizeName(name);
            const direct = stackMap[n];
            if (direct) return { title: direct.title, description: direct.description, icon: direct.icon };
            if (/^next(\.|$)/.test(n)) return { title: 'Next.js', description: stackMap['next'].description, icon: 'nextjs' };
            if (/^react(\.|$)/.test(n)) return { title: 'React', description: stackMap['react'].description, icon: 'react' };
            if (n.includes('typescript') || n === 'ts') return { title: 'TypeScript', description: stackMap['typescript'].description, icon: 'ts' };
            if (n.includes('javascript') || n === 'js') return { title: 'JavaScript', description: stackMap['javascript'].description, icon: 'js' };
            if (n.includes('node')) return { title: 'Node.js', description: 'V8-based JavaScript runtime for server-side applications.', icon: 'nodejs' };
            return null;
        };

        const { containerId, repoPath } = (inputData as any);

        const getCredToken = (): string | undefined => {
            try {
                const cwd = process.cwd();
                const primaryPath = path.resolve(cwd, '.docker.credentials');
                const fallbackPath = path.resolve(cwd, '..', '..', '.docker.credentials');
                const credPath = existsSync(primaryPath) ? primaryPath : (existsSync(fallbackPath) ? fallbackPath : undefined);
                if (!credPath) return undefined;
                const raw = readFileSync(credPath, 'utf8');
                const m = raw.match(/GITHUB_PAT\s*=\s*(.+)/);
                return m ? m[1].trim() : undefined;
            } catch { return undefined; }
        };

        const parseOwnerRepo = (): { owner?: string; repo?: string } => {
            let owner: string | undefined;
            let repo: string | undefined;
            const url = (inputData as any).repositoryUrl as string | undefined;
            if (url) {
                if (url.includes('github.com/')) {
                    const match = url.match(/github\.com\/([^\/]+)\/([^\/.]+)/);
                    if (match) { owner = match[1]; repo = match[2]; }
                } else if (url.includes('/') && !url.includes(' ')) {
                    const parts = url.split('/');
                    if (parts.length >= 2) { owner = parts[0]; repo = parts[1]; }
                }
            }
            if (!owner || !repo) {
                const ctxOwner = typeof context.owner === 'string' ? context.owner : undefined;
                const ctxRepo = typeof context.repo === 'string' ? context.repo : undefined;
                const fullName: string | undefined = typeof context.fullName === 'string' ? context.fullName : (typeof context.full_name === 'string' ? context.full_name : undefined);
                if (ctxOwner && ctxRepo) { owner = ctxOwner; repo = ctxRepo; }
                else if (fullName && fullName.includes('/')) {
                    const [o, r] = fullName.split('/'); owner = o; repo = r;
                }
            }
            return { owner, repo };
        };

        const fetchGithubLanguages = async (): Promise<Array<{ title: string; icon: string; description: string }>> => {
            try {
                const { owner, repo } = parseOwnerRepo();
                if (!owner || !repo) return [];
                const token = getCredToken();
                const headers: any = { 'Accept': 'application/vnd.github+json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, { headers });
                if (!res.ok) return [];
                const json = await res.json() as Record<string, number>;
                const sorted = Object.entries(json).sort((a,b) => b[1]-a[1]).map(([k]) => k);
                const mapped: Array<{ title: string; icon: string; description: string }> = [];
                for (const lang of sorted.slice(0, 8)) {
                    const item = mapToStackItem(lang.toLowerCase());
                    if (item) mapped.push(item);
                    else {
                        const lower = lang.toLowerCase();
                        const fallback = stackMap[lower];
                        if (fallback) mapped.push({ title: fallback.title, description: fallback.description, icon: fallback.icon });
                    }
                }
                return mapped;
            } catch { return []; }
        };

        const sh = (cmd: string): Promise<string> => new Promise((resolve, reject) => {
            exec(`docker exec ${containerId} bash -lc ${JSON.stringify(cmd)}`, (error, stdout, stderr) => {
                if (error) reject(new Error(stderr || error.message)); else resolve(stdout);
            });
        });

        const analyzeLocal = async (): Promise<Array<{ title: string; icon: string; description: string }>> => {
            const items: Array<{ title: string; icon: string; description: string }> = [];
            // Languages via extensions
            try {
                const filesOut = await sh(`cd ${JSON.stringify(repoPath)} && (git ls-files || find . -type f)`);
                const lines = filesOut.split('\n').map(l => l.trim()).filter(Boolean);
                const counts: Record<string, number> = {};
                for (const lf of lines) {
                    const name = lf.toLowerCase();
                    if (name.includes('node_modules')) continue;
                    const m = name.match(/\.([a-z0-9]+)$/);
                    const ext = m ? m[1] : '';
                    const map: Record<string, string> = {
                        'ts': 'typescript', 'tsx': 'typescript', 'js': 'javascript', 'jsx': 'javascript',
                        'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust', 'java': 'java', 'kt': 'kotlin',
                        'c': 'c', 'cpp': 'c++', 'cc': 'c++', 'cxx': 'c++', 'hpp': 'c++',
                        'php': 'php', 'swift': 'swift', 'scala': 'scala', 'sh': 'shell', 'css': 'css', 'scss': 'scss', 'html': 'html'
                    };
                    const lang = map[ext]; if (lang) counts[lang] = (counts[lang] || 0) + 1;
                }
                const langs = Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([k]) => k).slice(0, 5);
                for (const l of langs) { const it = mapToStackItem(l); if (it) items.push(it); }
            } catch {}
            // JS libraries via package.json
            try {
                const pjPath = `${repoPath}/package.json`;
                const exists = (await sh(`test -f ${JSON.stringify(pjPath)} && echo EXISTS || echo MISSING`)).trim();
                if (exists === 'EXISTS') {
                    const raw = await sh(`cat ${JSON.stringify(pjPath)}`);
                    const pkg = JSON.parse(raw);
                    const deps = Object.keys({ ...(pkg.dependencies||{}), ...(pkg.devDependencies||{}) });
                    const candidates = deps.map((d: string) => normalizeName(d));
                    for (const c of candidates) { const it = mapToStackItem(c); if (it) items.push(it); }
                }
            } catch {}
            // Python via requirements.txt
            try {
                const reqPath = `${repoPath}/requirements.txt`;
                const exists = (await sh(`test -f ${JSON.stringify(reqPath)} && echo EXISTS || echo MISSING`)).trim();
                if (exists === 'EXISTS') {
                    const raw = await sh(`cat ${JSON.stringify(reqPath)}`);
                    const pkgs = raw.split(/\r?\n/).map(l => l.trim().split('==')[0]).filter(Boolean);
                    for (const p of pkgs) { const it = mapToStackItem(p); if (it) items.push(it); }
                }
            } catch {}
            // Docker presence
            try {
                const dockerfile = (await sh(`test -f ${JSON.stringify(repoPath + '/Dockerfile')} && echo EXISTS || echo MISSING`)).trim();
                if (dockerfile === 'EXISTS') items.push(stackMap['docker']);
            } catch {}
            return items;
        };

        const fromGithub = await fetchGithubLanguages();
        const fromLocal = await analyzeLocal();

        const seen = new Set<string>();
        const techStack = [...fromGithub, ...fromLocal].filter(it => {
            const key = it.title.toLowerCase();
            if (seen.has(key)) return false; seen.add(key); return true;
        }).slice(0, 20);

        logger?.info("📨 Preparing to post project stack", {
            step: "post-project-stack",
            url: stackUrl,
            projectId,
            candidateCount: fromGithub.length + fromLocal.length,
            techStackCount: techStack.length,
            techStackSample: techStack.slice(0, 5),
            type: "BACKEND_POST",
            runId,
        });

        try {
            let successCount = 0;
            let lastError: string | undefined;

            // Send each tech stack item individually as the backend expects single items
            for (const item of techStack) {
                const payload = {
                    title: item.title,
                    description: item.description,
                    icon: item.icon || null, // Backend expects string | null
                };

                logger?.debug("🔗 HTTP request details", {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    url: stackUrl,
                    payload,
                    type: "HTTP_REQUEST",
                    runId,
                });

                const res = await fetch(stackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (res.ok) {
                    successCount++;
                    logger?.debug("✅ Stack item posted successfully", {
                        item: item.title,
                        status: res.status,
                        projectId,
                        type: "BACKEND_RESPONSE",
                        runId,
                    });
                } else {
                    const text = await res.text().catch(() => '');
                    lastError = `${item.title}: ${res.status} ${text}`;
                    logger?.warn("⚠️  Backend responded non-2xx for stack item", { 
                        item: item.title,
                        url: stackUrl, 
                        status: res.status, 
                        text: text.substring(0, 500), 
                        type: "BACKEND_POST", 
                        runId 
                    });
                }
            }

            const success = successCount > 0;
            logger?.info("📥 Backend stack posting completed", {
                successCount,
                totalItems: techStack.length,
                success,
                lastError,
                url: stackUrl,
                projectId,
                type: "BACKEND_RESPONSE",
                runId,
            });

            await notifyStepStatus({
                stepId: "post-project-stack-step",
                status: success ? "completed" : "failed",
                runId,
                containerId: inputData.containerId,
                title: success ? "Stack posted" : "Stack post failed",
                subtitle: success ? `Posted ${successCount}/${techStack.length} technologies` : `Failed to post stack${lastError ? `: ${lastError}` : ''}`,
            });

        } catch (err) {
            logger?.warn("⚠️  Failed to POST stack items", { 
                url: stackUrl,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                type: "BACKEND_POST",
                runId 
            });

            await notifyStepStatus({
                stepId: "post-project-stack-step",
                status: "failed",
                runId,
                containerId: inputData.containerId,
                title: "Stack post failed",
                subtitle: "Network error during stack posting",
            });
        }

        return {
            ...inputData,
            repositoryUrl: inputData.repositoryUrl,
            projectId: inputData.projectId,
        };
    },
});

export const dockerSaveContextStep = createStep({
    id: "docker-save-context-step",
    inputSchema: z.object({
        "post-project-description-step": z.object({
            result: z.string(),
            success: z.boolean(),
            toolCallCount: z.number(),
            containerId: z.string(),
            contextData: z.any().optional(),
            repositoryUrl: z.string().optional(),
            projectId: z.string(),
            repoPath: z.string(),
        }),
        "post-project-stack-step": z.object({
            result: z.string(),
            success: z.boolean(),
            toolCallCount: z.number(),
            containerId: z.string(),
            contextData: z.any().optional(),
            repositoryUrl: z.string().optional(),
            projectId: z.string(),
            repoPath: z.string(),
        }),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextPath: z.string().describe("Path where context was saved in the container"),
        repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    }),
    execute: async ({ inputData, mastra, runId }) => {
        const desc = (inputData as any)["post-project-description-step"];
        const containerId = desc.containerId;
        const contextData = desc.contextData;
        const repoPath = desc.repoPath || '';
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        const contextPath = "/app/agent.context.json";
        await notifyStepStatus({
            stepId: "save-context-step",
            status: "starting",
            runId,
            containerId,
            title: "Saving context to container",
            subtitle: `Writing ${contextData ? 'provided' : 'no'} context data`,
        });
        
        logger?.info("💾 Starting code-based context save to Docker container", {
            containerId: containerId.substring(0, 12),
            contextPath,
            hasContextData: !!contextData,
            type: "DOCKER_CONTEXT_SAVE",
            runId: runId,
        });

        try {
            // Error if no context data provided - this indicates a workflow issue
            if (!contextData) {
                const error = "No context data provided to saveContextStep - workflow execution error";
                logger?.error("❌ Context data missing", {
                    error,
                    type: "DOCKER_CONTEXT_SAVE",
                    runId: runId,
                });
                throw new Error(error);
            }

            const contextToSave = contextData;

            // Convert context to JSON string
            const contextJson = JSON.stringify(contextToSave, null, 2);
            
            logger?.debug("📝 Preparing to write context directly to container", {
                contextSize: `${Math.round(contextJson.length / 1024)}KB`,
                contextPath,
                type: "DOCKER_CONTEXT_SAVE",
                runId: runId,
            });

            // Write context file to temp location then copy to Docker container (fast and reliable)
            return await new Promise((resolve, reject) => {
                let tempFilePath: string | null = null;
                
                try {
                    // Create temp file with JSON content
                    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'docker-context-'));
                    tempFilePath = path.join(tempDir, 'context.json');
                    writeFileSync(tempFilePath, contextJson, 'utf8');
                    
                    logger?.debug("🐳 Copying context file to Docker container", {
                        tempFilePath,
                        contextPath,
                        type: "DOCKER_CONTEXT_SAVE",
                        runId: runId,
                    });

                    // Copy file to container
                    const copyCmd = `docker cp "${tempFilePath}" ${containerId}:${contextPath}`;
                    
                    exec(copyCmd, (copyError, copyStdout, copyStderr) => {
                        // Clean up temp file
                        if (tempFilePath) {
                            try {
                                unlinkSync(tempFilePath);
                            } catch (cleanupError) {
                                logger?.warn("⚠️  Failed to cleanup temp file", {
                                    tempFilePath,
                                    error: cleanupError instanceof Error ? cleanupError.message : 'Unknown error',
                                    type: "DOCKER_CONTEXT_SAVE",
                                    runId: runId,
                                });
                            }
                        }

                        if (copyError) {
                            logger?.error("❌ Failed to copy context file to container", {
                                error: copyStderr || copyError.message,
                                type: "DOCKER_CONTEXT_SAVE",
                                runId: runId,
                            });
                            reject(new Error(`Failed to copy context file to container: ${copyStderr || copyError.message}`));
                            return;
                        }

                        // Verify file exists and has content
                        const verifyCmd = `docker exec ${containerId} bash -c "test -f ${contextPath} && wc -c ${contextPath}"`;
                        
                        exec(verifyCmd, (verifyError, verifyStdout, verifyStderr) => {
                            if (verifyError) {
                                logger?.error("❌ Context file verification failed", {
                                    error: verifyStderr || verifyError.message,
                                    type: "DOCKER_CONTEXT_SAVE",
                                    runId: runId,
                                });
                                reject(new Error(`Context file verification failed: ${verifyStderr || verifyError.message}`));
                                return;
                            }

                            const fileSize = verifyStdout.trim().split(' ')[0] || '0';
                            logger?.info("✅ Context file successfully saved to Docker container", {
                                containerId: containerId.substring(0, 12),
                                contextPath,
                                fileSize: `${parseInt(fileSize)} bytes`,
                                contextSize: `${Math.round(contextJson.length / 1024)}KB`,
                                type: "DOCKER_CONTEXT_SAVE",
                                runId: runId,
                            });

                            notifyStepStatus({
                                stepId: "save-context-step",
                                status: "completed",
                                runId,
                                containerId,
                                contextPath,
                                title: "Context saved",
                                subtitle: `Saved to ${contextPath}`,
                                toolCallCount: cliToolMetrics.callCount,
                            });

                            resolve({
                                result: `Context successfully saved to ${contextPath} (${fileSize} bytes, ${Math.round(contextJson.length / 1024)}KB)`,
                                success: true,
                                toolCallCount: cliToolMetrics.callCount,
                                containerId,
                                contextPath,
                                repoPath: repoPath || "/app",
                            });
                        });
                    });
                } catch (tempError) {
                    // Clean up temp file on error
                    if (tempFilePath) {
                        try {
                            unlinkSync(tempFilePath);
                        } catch (cleanupError) {
                            // Ignore cleanup errors
                        }
                    }
                    
                    logger?.error("❌ Failed to create temp file for context", {
                        error: tempError instanceof Error ? tempError.message : 'Unknown error',
                        type: "DOCKER_CONTEXT_SAVE",
                        runId: runId,
                    });
                    reject(new Error(`Failed to create temp file: ${tempError instanceof Error ? tempError.message : 'Unknown error'}`));
                }
            });

        } catch (error) {
            logger?.error("❌ Context save operation failed", {
                error: error instanceof Error ? error.message : 'Unknown error',
                type: "DOCKER_CONTEXT_SAVE",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "save-context-step",
                status: "failed",
                runId,
                containerId,
                contextPath,
                title: "Context save failed",
                subtitle: error instanceof Error ? error.message : 'Unknown error',
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                result: `Context save failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                success: false,
                toolCallCount: cliToolMetrics.callCount,
                containerId,
                contextPath,
                repoPath: repoPath || "/app",
            };
        }
    }
});

export const testDockerWorkflow = createWorkflow({
    id: "test-docker-workflow",
    description: "Build Docker container, clone repository, post project info in parallel, and save context data efficiently using code-based operations",
    inputSchema: z.object({
        contextData: z.any().optional().describe("Optional context data to save to the container"),
        repositoryUrl: z.string().optional().describe("Optional repository URL or owner/repo format (e.g., 'owner/repo' or 'https://github.com/owner/repo')"),
        projectId: z.string().describe("Project ID associated with this workflow run"),
    }),
    outputSchema: z.object({
        result: z.string().describe("The result of the Docker operation"),
        success: z.boolean().describe("Whether the operation was successful"),
        toolCallCount: z.number().describe("Total number of tool calls made during execution"),
        containerId: z.string().describe("The ID of the created Docker container"),
        contextPath: z.string().describe("Path where context was saved in the container"),
        repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    }),
}).then(testDockerStep).then(testDockerGithubCloneStep).parallel([postProjectDescriptionStep, postProjectStackStep]).then(dockerSaveContextStep).commit();