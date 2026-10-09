#!/usr/bin/env bun

import { mkdirSync, existsSync } from "fs";
import { StateDB } from "./state";
import { daemonLoop, DAEMON_SUBCOMMAND } from "./daemon";
import { defaultRuntimeLayout } from "./runtime-layout";
import { COMMAND_CONTRACTS, runCli } from "./command-contract";
import { runTurnHook, TURN_HOOK_SUBCOMMAND } from "./turn-hooks";

const args = process.argv.slice(2);
if (args[0] === TURN_HOOK_SUBCOMMAND) {
  await runTurnHook(args.slice(1));
  process.exit(0);
}
const io = {
  print: (text: string) => console.log(text),
  printError: (text: string) => console.error(text),
};
if (COMMAND_CONTRACTS.find((command) => command.name === args[0])?.stateless) {
  process.exit(await runCli(undefined, args, io));
}

const ahelpaDotDir = defaultRuntimeLayout.ahelpaHomeDir();
if (!existsSync(ahelpaDotDir)) mkdirSync(ahelpaDotDir, { recursive: true });

const db = new StateDB(defaultRuntimeLayout.stateDbPath());

let exitCode = 0;
if (args[0] === DAEMON_SUBCOMMAND) {
  await daemonLoop(db);
} else {
  exitCode = await runCli(db, args, io);
}

db.close();
process.exit(exitCode);
