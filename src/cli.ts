#!/usr/bin/env bun

import { mkdirSync, existsSync } from "fs";
import { StateDB } from "./state";
import { daemonLoop, DAEMON_SUBCOMMAND } from "./daemon";
import { defaultRuntimeLayout } from "./runtime-layout";
import { runCli } from "./command-contract";

const ahelpaDotDir = defaultRuntimeLayout.ahelpaHomeDir();
if (!existsSync(ahelpaDotDir)) mkdirSync(ahelpaDotDir, { recursive: true });

const db = new StateDB(defaultRuntimeLayout.stateDbPath());
const args = process.argv.slice(2);

let exitCode = 0;
if (args[0] === DAEMON_SUBCOMMAND) {
  await daemonLoop(db);
} else {
  exitCode = await runCli(db, args, {
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
  });
}

db.close();
process.exit(exitCode);
