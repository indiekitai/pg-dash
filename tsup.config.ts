import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/mcp.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  external: ["pg", "open", "better-sqlite3", "ws", "@modelcontextprotocol/sdk", "zod"],
});
