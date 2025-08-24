import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

function parseCoverageFromText(text: string): number | null {
    try {
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            if (/All files/i.test(line)) {
                const nums = line.match(/\d{1,3}(?:\.\d+)?/g);
                if (nums && nums.length) {
                    const last = parseFloat(nums[nums.length - 1]);
                    if (!isNaN(last) && last >= 0 && last <= 100) return Math.max(0, Math.min(1, last / 100));
                }
            }
        }
        for (const line of lines) {
            if (/Total\s*\|/i.test(line)) {
                const nums = line.match(/\d{1,3}(?:\.\d+)?/g);
                if (nums && nums.length) {
                    const last = parseFloat(nums[nums.length - 1]);
                    if (!isNaN(last) && last >= 0 && last <= 100) return Math.max(0, Math.min(1, last / 100));
                }
            }
        }
        const percentMatch = text.match(/\b(\d{1,3}(?:\.\d+)?)%\b/g);
        if (percentMatch && percentMatch.length) {
            const lastPct = percentMatch[percentMatch.length - 1].replace('%','');
            const val = parseFloat(lastPct);
            if (!isNaN(val) && val >= 0 && val <= 100) return Math.max(0, Math.min(1, val / 100));
        }
        return null;
    } catch {
        return null;
    }
}

export const coverageParseTool = createTool({
    id: "coverage_parse",
    description: "Parse coverage ratio (0..1) from coverage files or stdout",
    inputSchema: z.object({
        containerId: z.string().describe("Docker container ID"),
        repoPath: z.string().describe("Repository path inside container"),
        stdout: z.string().optional().describe("Raw stdout/stderr to parse when files are missing"),
    }),
    execute: async ({ context }) => {
        const { containerId, repoPath, stdout } = context as any;
        if (!containerId || !repoPath) throw new Error("containerId and repoPath are required");
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");
        function sh(cmd: string): Promise<string> {
            return new Promise((resolve, reject) => {
                exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (error, out, err) => {
                    if (error) reject(new Error(err || error.message));
                    else resolve(out);
                });
            });
        }

        // Try JSON summaries first
        const candidates = [
            `${repoPath}/coverage/coverage-summary.json`,
            `${repoPath}/coverage/coverage-final.json`,
            `${repoPath}/coverage/coverage.json`,
        ];

        for (const file of candidates) {
            try {
                const content = await sh(`docker exec ${containerId} bash -lc "test -f ${JSON.stringify(file)} && cat ${JSON.stringify(file)} || echo 'NOT_FOUND'"`);
                const raw = content.trim();
                if (raw === 'NOT_FOUND' || !raw || raw.length < 2) continue;
                try {
                    const json = JSON.parse(raw);
                    if (json && json.total && json.total.lines && typeof json.total.lines.pct === 'number') {
                        return Math.max(0, Math.min(1, json.total.lines.pct / 100));
                    }
                    if (json && json.total && typeof json.total.statements === 'object' && typeof json.total.statements.pct === 'number') {
                        return Math.max(0, Math.min(1, json.total.statements.pct / 100));
                    }
                    if (json && json.totals && (typeof json.totals.percent_covered === 'number' || typeof json.totals.percent_covered_display === 'string')) {
                        const pct = typeof json.totals.percent_covered === 'number' ? json.totals.percent_covered : parseFloat(String(json.totals.percent_covered_display).replace('%',''));
                        if (!isNaN(pct)) return Math.max(0, Math.min(1, pct / 100));
                    }
                } catch {}
            } catch {}
        }

        // XML cobertura
        try {
            const xmlPath = `${repoPath}/coverage/coverage.xml`;
            const out = await sh(`docker exec ${containerId} bash -lc "test -f ${JSON.stringify(xmlPath)} && grep -Eo 'line-rate=\\"[0-9.]+' ${JSON.stringify(xmlPath)} | head -1 | sed -E 's/.*\"([0-9.]+)/\\1/' || echo 'NOT_FOUND'"`);
            const raw = out.trim();
            if (raw !== 'NOT_FOUND') {
                const rate = parseFloat(raw);
                if (!isNaN(rate)) return Math.max(0, Math.min(1, rate));
            }
        } catch {}

        // Fallback to stdout parsing
        if (typeof stdout === 'string' && stdout) {
            const ratio = parseCoverageFromText(stdout);
            if (ratio !== null) return Math.max(0, Math.min(1, ratio));
        }

        return 0;
    },
});


