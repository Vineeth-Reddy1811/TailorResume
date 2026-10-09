const { spawn } = require("node:child_process");

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run the local web app with `npm run web:dev`.");
  process.exit(1);
}

let shuttingDown = false;
const children = [];

function startScript(script) {
  const child = spawn(process.execPath, [npmCli, "run", script], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (error) => {
    console.error(`Could not start ${script}:`, error.message);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (!shuttingDown) shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

async function waitForApi() {
  const healthUrl = `http://127.0.0.1:${process.env.WEB_PORT || 4170}/api/health`;
  const deadline = Date.now() + 30_000;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(750) });
      if (response.ok) return true;
    } catch {
      // The API is still compiling or binding its local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function start() {
  startScript("web:api");
  if (!await waitForApi()) {
    if (!shuttingDown) {
      console.error("The local API did not become ready within 30 seconds; the web UI was not started.");
      shutdown(1);
    }
    return;
  }
  if (!shuttingDown) startScript("web:ui");
}

void start();

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
