#!/usr/bin/env node
// check-destructive-migrations.cjs
// Fails if a NEW Prisma migration contains a data-destroying statement that was
// not consciously reviewed. This is the CI/pre-commit guard against the class of
// change that wiped this database (DROP/TRUNCATE/mass DELETE|UPDATE).
//
// It NEVER edits migration files (editing an applied migration.sql breaks Prisma's
// checksum). To allow a legitimately destructive migration, put a marker line in it:
//     -- SAFETY-REVIEWED: <who/why>
//
// Usage:
//   node scripts/check-destructive-migrations.cjs            # new/changed vs origin/main (+ untracked)
//   node scripts/check-destructive-migrations.cjs --base HEAD~1
//   node scripts/check-destructive-migrations.cjs --all      # audit every migration
//
// ponytail: naive `;` statement split + regex; fine for Prisma-generated SQL.
// Upgrade to a real SQL parser only if false positives become a problem.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MIG_DIR = path.join(__dirname, "..", "prisma", "migrations");
const MARKER = /--\s*SAFETY-REVIEWED:/i;

// Data-destroying patterns. Index/constraint/default drops are intentionally excluded
// (they do not destroy row data). Missing WHERE on DELETE/UPDATE = mass mutation.
const CHECKS = [
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { name: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/i },
  { name: "DROP SCHEMA", re: /\bDROP\s+SCHEMA\b/i },
  { name: "DROP DATABASE", re: /\bDROP\s+DATABASE\b/i },
  { name: "TRUNCATE", re: /\bTRUNCATE\b/i },
];

function args() {
  const a = process.argv.slice(2);
  return { all: a.includes("--all"), base: (a[a.indexOf("--base") + 1] && a.includes("--base")) ? a[a.indexOf("--base") + 1] : "origin/main" };
}

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: path.join(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

function allSqlFiles() {
  if (!fs.existsSync(MIG_DIR)) return [];
  return fs.readdirSync(MIG_DIR)
    .map((d) => path.join(MIG_DIR, d, "migration.sql"))
    .filter((f) => fs.existsSync(f));
}

function changedSqlFiles(base) {
  const rel = "prisma/migrations";
  const diff = git(`diff --name-only --diff-filter=AMR ${base}...HEAD -- ${rel}`);
  const untracked = git(`ls-files --others --exclude-standard -- ${rel}`);
  if (diff === null && untracked === null) return null; // git unavailable
  const set = new Set(
    [diff, untracked].filter(Boolean).join("\n").split("\n")
      .map((s) => s.trim()).filter((s) => s.endsWith(".sql"))
  );
  return [...set].map((f) => path.join(__dirname, "..", f)).filter((f) => fs.existsSync(f));
}

// Strip -- line comments and /* */ block comments before pattern matching.
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function findings(sql) {
  const out = [];
  const stmts = stripComments(sql).split(";");
  for (const raw of stmts) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (!s) continue;
    for (const c of CHECKS) if (c.re.test(s)) out.push(c.name);
    if (/\bDELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s)) out.push("DELETE without WHERE");
    if (/\bUPDATE\b/i.test(s) && /\bSET\b/i.test(s) && !/\bWHERE\b/i.test(s)) out.push("mass UPDATE (no WHERE)");
  }
  return [...new Set(out)];
}

function main() {
  const { all, base } = args();
  let files;
  if (all) {
    files = allSqlFiles();
  } else {
    files = changedSqlFiles(base);
    if (files === null) {
      console.warn(`[migration-guard] git unavailable — falling back to --all audit.`);
      files = allSqlFiles();
    }
  }

  if (files.length === 0) {
    console.log(`[migration-guard] no ${all ? "" : "new "}migration SQL to check. OK.`);
    return;
  }

  let failed = false;
  for (const f of files) {
    const sql = fs.readFileSync(f, "utf8");
    const hits = findings(sql);
    const label = path.relative(path.join(__dirname, ".."), f);
    if (hits.length === 0) continue;
    if (MARKER.test(sql)) {
      console.log(`[migration-guard] ⚠ reviewed destructive migration allowed: ${label} (${hits.join(", ")})`);
      continue;
    }
    failed = true;
    console.error(`[migration-guard] ❌ ${label}`);
    for (const h of hits) console.error(`                   destructive: ${h}`);
  }

  if (failed) {
    console.error(`\n[migration-guard] Destructive statements found in a new migration.`);
    console.error(`If intentional and safe, add a marker line to that migration.sql:`);
    console.error(`    -- SAFETY-REVIEWED: <your name / reason>`);
    console.error(`Never run 'prisma db push' or 'migrate reset' against staging/production.`);
    process.exit(1);
  }
  console.log(`[migration-guard] ${files.length} migration file(s) checked. No unreviewed destructive statements. OK.`);
}

main();
