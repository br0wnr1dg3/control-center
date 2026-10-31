#!/usr/bin/env node
// Set up a new machine: clone every repo the board knows about (the runner's published inventory,
// minus hidden ones) into the same folders, so agents find the same paths everywhere.
//
//   node runner/clone-repos.mjs            clone what's missing
//   node runner/clone-repos.mjs --dry-run  just list it
//
// Uses the service key from the Keychain ("control-center service key") like the runner, and git
// with your GitHub credentials (run `gh auth login` first).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const url = process.env.CC_SUPABASE_URL ?? "https://lkjjphjscavzibalgqhh.supabase.co";
const key =
  process.env.CC_SERVICE_KEY ??
  execFileSync("security", ["find-generic-password", "-a", "control-center", "-s", "control-center service key", "-w"]).toString().trim();
const dryRun = process.argv.includes("--dry-run");

const res = await fetch(`${url}/rest/v1/repos?hidden=eq.false&select=name,path,github_url&order=path`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const repos = await res.json();

let cloned = 0, present = 0;
const skipped = [];
for (const repo of repos) {
  const path = repo.path.replace(/^~(?=\/|$)/, homedir());
  if (existsSync(path)) { present++; continue; }
  if (!repo.github_url) { skipped.push(`${repo.path} (no GitHub remote)`); continue; }
  console.log(`${dryRun ? "would clone" : "cloning"} ${repo.github_url} -> ${repo.path}`);
  if (dryRun) continue;
  mkdirSync(dirname(path), { recursive: true });
  try {
    execFileSync("git", ["clone", "--quiet", `${repo.github_url}.git`, path], { stdio: "inherit" });
    cloned++;
  } catch {
    skipped.push(`${repo.path} (clone failed)`);
  }
}
console.log(`\n${present} already here, ${dryRun ? "0 (dry run)" : cloned} cloned, ${skipped.length} skipped`);
for (const s of skipped) console.log(`  skipped ${s}`);
