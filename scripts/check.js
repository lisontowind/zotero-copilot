"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const runtimeFiles = ["bootstrap.js", "copilot.js", "preferences.js", "prefs.js"];
const scripts = fs.readdirSync(__dirname).filter((file) => file.endsWith(".js")).map((file) => "scripts/" + file);
const markdown = fs.readdirSync(path.join(root, "markdown")).filter((file) => file.endsWith(".js")).map((file) => "markdown/" + file);

function run(args) {
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of [...runtimeFiles, ...markdown, ...scripts]) run(["--check", file]);
console.log("JavaScript syntax checks passed");
for (const file of ["mineru-reading-harness.js", "markdown-copy-harness.js", "chat-runtime-harness.js"]) {
	run([path.join("scripts", file)]);
}
