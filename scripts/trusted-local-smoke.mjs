const args = process.argv.slice(2);
const help = "Usage: npm run smoke:copilot -- --allow-real-provider\n"
  + "Runs real Copilot with native tools and explicit allow-all in a disposable synthetic repository.\n"
  + "May use network, provider credentials, configured MCP, and custom instructions.\n"
  + "Torsor is not an OS sandbox; provider-owned sessions may remain outside its cleanup.\n"
  + "Without --allow-real-provider, no resources or provider environment are accessed.\n";

if (new Set(args).size !== args.length ||
    args.some((arg) => !["--help", "--allow-real-provider"].includes(arg))) {
  process.stderr.write("Invalid smoke arguments. Use --help.\n");
  process.exitCode = 2;
} else if (args.includes("--help")) {
  process.stdout.write(help);
} else if (!args.includes("--allow-real-provider")) {
  process.stderr.write("Refusing real provider smoke: pass --allow-real-provider explicitly.\n");
  process.exitCode = 2;
} else {
  try {
    const { runSmoke } = await import("./trusted-local-smoke-run.mjs");
    await runSmoke();
    process.stdout.write("Trusted-local synthetic edit and test completed; disposable data removed.\n");
  } catch {
    process.stderr.write("Trusted-local smoke failed; no provider diagnostics retained. Unconfirmed stop requires local quarantine reconciliation.\n");
    process.exitCode = 1;
  }
}
