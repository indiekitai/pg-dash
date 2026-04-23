import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src/cli.ts");
const run = (args: string) => execSync(`npx tsx ${CLI_PATH} ${args}`, { encoding: "utf-8", timeout: 10000, cwd: PROJECT_ROOT }).trim();

describe("CLI", () => {
  it("--version outputs version", () => {
    const output = run("--version");
    expect(output).toMatch(/^pg-dash v\d+\.\d+\.\d+$/);
  });

  it("--help outputs usage info", () => {
    const output = run("--help");
    expect(output).toContain("pg-dash");
    expect(output).toContain("Usage:");
    expect(output).toContain("--port");
    expect(output).toContain("--auth");
    expect(output).toContain("--token");
  });

  it("exits with error when no connection string provided", () => {
    expect(() => {
      execSync(`npx tsx ${CLI_PATH}`, { encoding: "utf-8", timeout: 10000, stdio: "pipe" });
    }).toThrow();
  });

  it("check subcommand exits with error for invalid connection", () => {
    expect(() => {
      execSync(`npx tsx ${CLI_PATH} check postgresql://invalid:5432/nope`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: "pipe",
      });
    }).toThrow();
  });
});
