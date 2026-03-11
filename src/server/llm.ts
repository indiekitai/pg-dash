// LLM module for natural language to SQL conversion

import { getDbContext } from "./queries/db-context.js";
import type { Pool } from "pg";
import type { AdvisorReport } from "./advisor.js";
import type { DiffResult } from "./env-differ.js";

export interface LLMConfig {
  provider: "openai" | "anthropic" | "google" | "ollama";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface SQLResult {
  rows: any[];
  rowCount: number;
  columns: string[];
}

/**
 * Get LLM configuration from environment variables
 */
export function getLLMConfig(): LLMConfig {
  const provider = (process.env.PG_DASH_LLM_PROVIDER || "openai") as LLMConfig["provider"];
  
  return {
    provider,
    apiKey: process.env.PG_DASH_LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_API_KEY,
    baseUrl: process.env.PG_DASH_LLM_BASE_URL,
    model: process.env.PG_DASH_LLM_MODEL,
  };
}

/**
 * Build database context prompt for LLM
 */
async function buildDatabaseContext(pool: Pool): Promise<string> {
  const dbContext = await getDbContext(pool);
  
  const tableInfos = dbContext.tables.slice(0, 30).map((table: any) => {
    const columns = table.columns.map((col: any) => 
      `  - ${col.name}: ${col.type}${col.isPrimaryKey ? " (PK)" : ""}${col.isForeignKey ? ` (FK -> ${col.references?.table}.${col.references?.column})` : ""}`
    ).join("\n");
    
    return `### ${table.schema}.${table.name} (${table.rowCount || "?"} rows, ${table.totalSize || "?"})
${columns}`;
  }).join("\n\n");

  return `Database Schema (top tables by size):
${tableInfos}

Generate a PostgreSQL SELECT query to answer the user's question. 
Rules:
1. Only generate SELECT queries - no INSERT, UPDATE, DELETE, or DDL
2. Use proper JOINs if needed
3. Use LIMIT to cap results at 100 rows unless user specifies otherwise
4. Use table aliases for clarity
5. For time-based queries, use NOW() - INTERVAL syntax
6. Use pg_ prefix system tables only if necessary

Return ONLY the SQL query, no explanations.`;
}

/**
 * Call LLM to convert natural language to SQL
 */
async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const { provider, apiKey, baseUrl, model } = config;
  
  if (!apiKey) {
    throw new Error(`API key not configured. Set PG_DASH_LLM_API_KEY (or OPENAI_API_KEY/ANTHROPIC_API_KEY/GOOGLE_API_KEY)`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  let url: string;
  let body: any;

  switch (provider) {
    case "openai":
      url = (baseUrl || "https://api.openai.com/v1") + "/chat/completions";
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = {
        model: model || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0,
      };
      break;

    case "anthropic":
      url = (baseUrl || "https://api.anthropic.com/v1") + "/messages";
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: model || "claude-3-haiku-20240307",
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: 1024,
      };
      break;

    case "google":
      url = (baseUrl || "https://generativelanguage.googleapis.com/v1beta") + `/models/${model || "gemini-2.0-flash-exp"}:generateContent?key=${apiKey}`;
      body = {
        contents: [{ parts: [{ text: `System: ${systemPrompt}\n\nUser: ${userPrompt}` }] }],
        generationConfig: { temperature: 0 },
      };
      break;

    case "ollama":
      url = (baseUrl || "http://localhost:11434") + "/api/generate";
      body = {
        model: model || "llama3.2",
        prompt: `System: ${systemPrompt}\n\nUser: ${userPrompt}`,
        stream: false,
      };
      break;

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Extract SQL from response
  switch (provider) {
    case "openai":
      return data.choices?.[0]?.message?.content?.trim() || "";
    case "anthropic":
      return data.content?.[0]?.text?.trim() || "";
    case "google":
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    case "ollama":
      return data.response?.trim() || "";
    default:
      return "";
  }
}

/**
 * Validate that SQL is a safe SELECT query
 */
export function validateSQL(sql: string): { valid: boolean; error?: string } {
  const trimmed = sql.trim();
  
  // Must start with SELECT
  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return { valid: false, error: "Only SELECT queries are allowed" };
  }
  
  // Block dangerous patterns
  const dangerous = [
    /;\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE)/i,
    /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE)\b/i,
    /pg_terminate_backend/i,
    /pg_cancel_backend/i,
    /\bCOPY\b/i,
    /\bEXPLAIN\b.*\b(SELECT|INSERT|UPDATE|DELETE)\b/i,  // Allow EXPLAIN but wrap it
  ];
  
  for (const pattern of dangerous) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: `Disallowed pattern in query: ${pattern.source}` };
    }
  }
  
  // Add LIMIT if not present
  let finalSql = trimmed;
  if (!/\bLIMIT\b/i.test(trimmed)) {
    finalSql = `${trimmed} LIMIT 100`;
  }
  
  return { valid: true, sql: finalSql };
}

/**
 * Execute natural language query
 */
export async function executeNaturalQuery(
  pool: Pool, 
  naturalQuery: string,
  config?: LLMConfig
): Promise<{ 
  answer: string; 
  sql: string; 
  result?: SQLResult;
  error?: string;
}> {
  const llmConfig = config || getLLMConfig();
  
  // Build database context
  const contextPrompt = await buildDatabaseContext(pool);
  const fullPrompt = `${contextPrompt}\n\nUser's question: ${naturalQuery}\n\nGenerate the SQL query now:`;
  
  // Call LLM
  let sql: string;
  try {
    sql = await callLLM(llmConfig, 
      "You are a PostgreSQL expert. Generate only SELECT queries based on the schema provided.",
      fullPrompt
    );
  } catch (err: any) {
    return {
      answer: "",
      sql: "",
      error: `LLM call failed: ${err.message}`,
    };
  }
  
  // Extract SQL from markdown if present
  const sqlMatch = sql.match(/```sql\n?([\s\S]*?)```/) || sql.match(/```\n?([\s\S]*?)```/) || [null, sql];
  let extractedSql = sqlMatch[1]?.trim() || sql.trim();
  
  // Validate SQL
  const validation = validateSQL(extractedSql);
  if (!validation.valid) {
    return {
      answer: "",
      sql: extractedSql,
      error: `SQL validation failed: ${validation.error}`,
    };
  }
  
  extractedSql = validation.sql!;
  
  // Execute SQL
  let result: SQLResult;
  const client = await pool.connect();
  try {
    const queryResult = await client.query(extractedSql);
    result = {
      rows: queryResult.rows,
      rowCount: queryResult.rowCount || 0,
      columns: queryResult.fields?.map(f => f.name) || [],
    };
  } catch (err: any) {
    return {
      answer: "",
      sql: extractedSql,
      error: `SQL execution failed: ${err.message}`,
    };
  } finally {
    client.release();
  }
  
  // Generate natural language answer
  let answer = "";
  if (result.rows.length === 0) {
    answer = "No results found for your query.";
  } else if (result.rows.length === 1) {
    answer = `Found 1 result: ${JSON.stringify(result.rows[0])}`;
  } else {
    answer = `Found ${result.rowCount} results. Showing first ${Math.min(result.rows.length, 10)}:`;
    answer += "\n\n" + JSON.stringify(result.rows.slice(0, 10), null, 2);
    if (result.rows.length > 10) {
      answer += `\n\n... and ${result.rows.length - 10} more rows (limited to 100)`;
    }
  }
  
  return {
    answer,
    sql: extractedSql,
    result,
  };
}

/**
 * Generate AI-powered suggestions for health check issues
 */
export async function generateAISuggestions(
  report: AdvisorReport,
  config?: LLMConfig
): Promise<{ summary: string; suggestions: Array<{ issue: string; suggestion: string; priority: string }> }> {
  const llmConfig = config || getLLMConfig();
  
  if (!llmConfig.apiKey) {
    return {
      summary: `Health Score: ${report.score}/100 (${report.grade}). ${report.issues.length} issues found.`,
      suggestions: report.issues.map(issue => ({
        issue: issue.title,
        suggestion: issue.description,
        priority: issue.severity,
      })),
    };
  }

  const issuesText = report.issues.map(i => 
    `- [${i.severity}] ${i.title}: ${i.description}`
  ).join("\n");

  const prompt = `You are a PostgreSQL database expert. Analyze this health check report and provide:
1. A one-sentence summary of the overall database health status
2. Prioritized fix suggestions for each issue (most critical first)

Health Report:
- Score: ${report.score}/100 (Grade: ${report.grade})
- Issues: ${report.issues.length}

Issues:
${issuesText}

Return a JSON object with this exact structure:
{
  "summary": "one sentence summary",
  "suggestions": [
    { "issue": "issue title", "suggestion": "what to do", "priority": "critical|warning|info" }
  ]
}

Only include issues that have actionable suggestions. Prioritize by severity (critical > warning > info).`;

  try {
    const response = await callLLM(llmConfig,
      "You are a PostgreSQL expert. Return only valid JSON.",
      prompt
    );
    
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || `Health Score: ${report.score}/100 (${report.grade})`,
        suggestions: parsed.suggestions || [],
      };
    }
  } catch (err) {
    console.error("[llm] AI suggestions error:", err);
  }

  // Fallback to non-AI response
  return {
    summary: `Health Score: ${report.score}/100 (${report.grade}). ${report.issues.length} issues found.`,
    suggestions: report.issues.map(issue => ({
      issue: issue.title,
      suggestion: issue.description,
      priority: issue.severity,
    })),
  };
}

/**
 * Explain schema differences with business context
 */
export async function explainSchemaDiff(
  diff: DiffResult,
  config?: LLMConfig
): Promise<string> {
  const llmConfig = config || getLLMConfig();

  if (!llmConfig.apiKey) {
    // Return basic summary without AI
    const parts: string[] = [];
    if (diff.schema.missingTables.length > 0) {
      parts.push(`Missing tables: ${diff.schema.missingTables.join(", ")}`);
    }
    if (diff.schema.extraTables.length > 0) {
      parts.push(`Extra tables: ${diff.schema.extraTables.join(", ")}`);
    }
    if (diff.schema.columnDiffs.length > 0) {
      parts.push(`Column changes in ${diff.schema.columnDiffs.length} tables`);
    }
    return parts.length > 0 ? parts.join("; ") : "No schema differences found.";
  }

  // Build diff description for LLM
  const changes: string[] = [];
  
  for (const t of diff.schema.missingTables) {
    changes.push(`- Table '${t}' exists in source but not in target`);
  }
  
  for (const t of diff.schema.extraTables) {
    changes.push(`- Table '${t}' exists in target but not in source`);
  }
  
  for (const cd of diff.schema.columnDiffs) {
    for (const col of cd.missingColumns) {
      changes.push(`- Table '${cd.table}' missing column '${col.name}' (${col.type})`);
    }
    for (const col of cd.extraColumns) {
      changes.push(`- Table '${cd.table}' has extra column '${col.name}' (${col.type})`);
    }
    for (const td of cd.typeDiffs) {
      changes.push(`- Table '${cd.table}' column '${td.column}' type changed: ${td.sourceType} → ${td.targetType}`);
    }
  }

  const prompt = `You are a PostgreSQL database expert. Explain the business impact of these schema differences in plain English.
Focus on what these changes likely mean for the application (e.g., "Table 'orders' added column 'status' — likely for order state tracking").

Schema Differences:
${changes.join("\n") || "No differences"}

Return a natural language explanation that is:
1. Concise but informative
2. Focused on business impact
3. Developer-friendly

Example format:
"Table 'orders' added column 'status' — likely for order state tracking"
"Table 'users' missing column 'email' — may break password reset functionality"

Return only the explanation, no JSON:`;

  try {
    const response = await callLLM(llmConfig,
      "You are a PostgreSQL expert. Provide clear, actionable explanations.",
      prompt
    );
    return response.trim();
  } catch (err) {
    console.error("[llm] Schema diff explanation error:", err);
    return "Unable to generate AI explanation. Review the diff manually.";
  }
}
