import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

function sh(cmd: string): Promise<{ stdout: string; stderr: string }>{
    return new Promise((resolve, reject) => {
        const { exec } = require("child_process");
        exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (error: any, stdout: string, stderr: string) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

function shellEscape(str: string): string {
    return "'" + String(str).replace(/'/g, "'\"'\"'") + "'";
}

export const coverageDetectionTool = createTool({
    id: "coverage_detection",
    description: "Detect project type and choose best coverage command inside a Docker container",
    inputSchema: z.object({
        containerId: z.string().describe("Docker container ID"),
        repoPath: z.string().optional().describe("Optional absolute repo path inside the container"),
    }),
    execute: async ({ context }) => {
        const containerId = context?.containerId as string;
        let repoPath = (context?.repoPath as string) || "";
        if (!containerId) throw new Error("containerId is required");

        cliToolMetrics.callCount += 1;

        try {
            if (!repoPath) {
                const { stdout } = await sh(`docker exec ${containerId} bash -lc "for d in /app/*; do if [ -d \"\$d/.git\" ]; then echo \"\$d\"; break; fi; done"`);
                repoPath = stdout.trim() || "/app";
            }
        } catch {
            repoPath = "/app";
        }

        // Defaults
        let language: string = "unknown";
        let framework: string = "unknown";
        let installCmd: string | null = null;
        let coverageCmd: string = "";

        // Node.js detection via package.json
        try {
            const { stdout } = await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && test -f package.json && echo YES || echo NO"`);
            if (stdout.trim() === 'YES') {
                language = 'node';
                // Look for vitest or jest
                const { stdout: whichFw } = await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && node -e \"try{const p=require('./package.json');const d=p.devDependencies||{};const dp=p.dependencies||{};if(d['vitest']||dp['vitest']){console.log('vitest')}else if(d['jest']||dp['jest']){console.log('jest')}else{console.log('unknown')}}catch(e){console.log('unknown')}\""`);
                framework = whichFw.trim() || 'unknown';
                // Prefer npm ci when lockfile exists
                const { stdout: hasLock } = await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && test -f package-lock.json && echo YES || echo NO"`);
                installCmd = hasLock.trim() === 'YES' ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
                if (framework === 'vitest') {
                    coverageCmd = 'npx -y vitest run --coverage';
                } else if (framework === 'jest') {
                    coverageCmd = 'npx -y jest --coverage --ci';
                } else {
                    // Check for script
                    try {
                        const { stdout: hasScript } = await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && node -e \"const p=require('./package.json');console.log(p.scripts&&p.scripts['test:coverage']?'YES':'NO')\""`);
                        if (hasScript.trim() === 'YES') {
                            coverageCmd = 'npm run -s test:coverage';
                        } else {
                            coverageCmd = 'npm test -- --coverage || true';
                        }
                    } catch {
                        coverageCmd = 'npm test -- --coverage || true';
                    }
                }
            }
        } catch {}

        // Python fallback detection
        if (!coverageCmd) {
            try {
                const { stdout: hasPy } = await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && (test -f pytest.ini || test -f pyproject.toml || test -f requirements.txt) && echo YES || echo NO"`);
                if (hasPy.trim() === 'YES') {
                    language = language === 'unknown' ? 'python' : language;
                    framework = 'pytest';
                    installCmd = 'pip3 install --no-input --quiet pytest pytest-cov';
                    coverageCmd = 'pytest -q --maxfail=1 --disable-warnings --cov=. --cov-report=term-missing --cov-report=json:coverage/coverage.json';
                }
            } catch {}
        }

        // Compose recommendation
        return {
            repoPath,
            language,
            framework,
            install: installCmd,
            run: coverageCmd || 'echo "No coverage command detected"',
        };
    },
});


