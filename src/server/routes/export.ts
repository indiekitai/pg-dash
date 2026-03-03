import type { Hono } from "hono";
import type { Pool } from "pg";
import { getOverview } from "../queries/overview.js";
import { getAdvisorReport, gradeFromScore } from "../advisor.js";

export function registerExportRoutes(app: Hono, pool: Pool, longQueryThreshold: number) {
  app.get("/api/export", async (c) => {
    const format = c.req.query("format") || "json";

    try {
      const [overview, advisor] = await Promise.all([
        getOverview(pool),
        getAdvisorReport(pool, longQueryThreshold),
      ]);

      if (format === "md") {
        const lines: string[] = [];
        lines.push(`# pg-dash Health Report`);
        lines.push(`\nGenerated: ${new Date().toISOString()}\n`);
        lines.push(`## Overview\n`);
        lines.push(`- **PostgreSQL**: ${overview.version}`);
        lines.push(`- **Database Size**: ${overview.dbSize}`);
        lines.push(`- **Connections**: ${overview.connections.active} active / ${overview.connections.idle} idle / ${overview.connections.max} max`);
        lines.push(`\n## Health Score: ${advisor.score}/100 (Grade: ${advisor.grade})\n`);
        lines.push(`### Category Breakdown\n`);
        lines.push(`| Category | Grade | Score | Issues |`);
        lines.push(`|----------|-------|-------|--------|`);
        for (const [cat, b] of Object.entries(advisor.breakdown)) {
          lines.push(`| ${cat} | ${b.grade} | ${b.score}/100 | ${b.count} |`);
        }
        if (advisor.issues.length > 0) {
          lines.push(`\n### Issues (${advisor.issues.length})\n`);
          for (const issue of advisor.issues) {
            const icon = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
            lines.push(`#### ${icon} [${issue.severity}] ${issue.title}\n`);
            lines.push(`${issue.description}\n`);
            lines.push(`**Impact**: ${issue.impact}\n`);
            lines.push(`**Fix**:\n\`\`\`sql\n${issue.fix}\n\`\`\`\n`);
          }
        } else {
          lines.push(`\n✅ No issues found!\n`);
        }
        const md = lines.join("\n");
        c.header("Content-Type", "text/markdown; charset=utf-8");
        c.header("Content-Disposition", `attachment; filename="pg-dash-report-${new Date().toISOString().slice(0, 10)}.md"`);
        return c.body(md);
      }

      // Default: JSON
      const data = { overview, advisor, exportedAt: new Date().toISOString() };
      c.header("Content-Disposition", `attachment; filename="pg-dash-report-${new Date().toISOString().slice(0, 10)}.json"`);
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}
