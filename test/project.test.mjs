import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, projectDirOf, projectOf, projectRootOf } from "../test-build/config.js";

/**
 * A project is the repository, not the folder an agent happened to start in.
 * Codex in `backend/` and Claude Code at the top must file under one name,
 * or each agent's memory is invisible to the other.
 */

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    process.stdout.write(`\n✗ ${name}\n  ${err.message.split("\n")[0]}\n`);
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mem-project-"));
const repo = path.join(base, "myrepo");
const nested = path.join(repo, "backend", "app");
const loose = path.join(base, "loose", "dir");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(loose, { recursive: true });

const noWalls = ConfigSchema.parse({ vault: base, sources: {} });
const walled = ConfigSchema.parse({
  vault: base,
  sources: {},
  walls: [{ name: "المشروع", paths: [repo], localOnly: true }],
});

check("the root is the nearest ancestor holding .git", () => {
  assert.equal(projectRootOf(nested), repo, "لم يصعد إلى .git");
  assert.equal(projectRootOf(repo), repo, "الجذر نفسه لا يتعرّف على نفسه");
});

check("no .git anywhere means no root", () => {
  assert.equal(projectRootOf(loose), null);
});

check("a session started in a subfolder files under the repository, not the subfolder", () => {
  assert.equal(projectOf(noWalls, nested), "myrepo", "المشروع أخذ اسم المجلد الفرعي");
  assert.equal(projectOf(noWalls, loose), "dir", "بلا .git يبقى اسم المجلد");
});

check("a wall's name still wins over the repository name", () => {
  assert.equal(projectOf(walled, nested), "المشروع");
});

check("the project directory is the wall's path, else the root, else the cwd", () => {
  assert.equal(projectDirOf(walled, nested), repo, "مجلد الجدار");
  assert.equal(projectDirOf(noWalls, nested), repo, "جذر المستودع");
  assert.equal(projectDirOf(noWalls, loose), loose, "cwd بلا جذر");
  assert.equal(projectDirOf(noWalls, null), null);
});

fs.rmSync(base, { recursive: true, force: true });

process.stdout.write(`\nproject: ${pass} ناجح · ${fail} فاشل\n`);
if (fail) process.exit(1);
