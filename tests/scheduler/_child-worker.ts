import { appendFileSync } from "fs";
import * as engine from "../../src/lib/scheduler/engine";

// One BOS server process, as far as the scheduler is concerned: it imports the
// real engine, so it has its own `runningJobIds` set and its own globalThis
// daemon state — exactly the situation the Supervisor creates with a BASE and a
// PREVIEW process (042-scheduler-daemon-lock). Bundled by _bundle.ts and
// spawned by the tests in this folder.
//
// Modes (argv[2]):
//   dispatch — register a marker handler, wait for the shared barrier instant,
//              then run ONE engine tick. Every process that dispatches the due
//              job appends its pid to CHILD_MARKER.
//   run-now  — same, but dispatch through runJobNow() (no schedule math
//              involved, so the assertion is purely about lock exclusivity).
//   elect    — start the daemon and report ownership transitions on stdout
//              ("OWNER <pid>" / "LOSER <pid>"), staying alive until killed.

const mode = process.argv[2];
const marker = process.env.CHILD_MARKER ?? "";
const barrierAt = Number(process.env.CHILD_BARRIER ?? "0");
const jobId = process.env.CHILD_JOB_ID ?? "";
const holdMs = Number(process.env.CHILD_HOLD_MS ?? "800");
const electionMs = Number(process.env.CHILD_ELECTION_MS ?? "300");
const lifetimeMs = Number(process.env.CHILD_LIFETIME_MS ?? "20000");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBarrier(): Promise<void> {
  while (Date.now() < barrierAt) await sleep(2);
}

function installMarkerHandler(): void {
  engine.registerHandler("internal", async () => {
    // Written FIRST, before any store mutation, so the marker file counts
    // dispatches even if a later process would have been skipped by the
    // freshly-advanced nextRunAt.
    appendFileSync(marker, `${process.pid}\n`, "utf8");
    await sleep(holdMs);
    return { status: "success", output: `ran in pid ${process.pid}` };
  });
}

async function main(): Promise<void> {
  if (mode === "dispatch" || mode === "run-now") {
    installMarkerHandler();
    await waitForBarrier();
    if (mode === "dispatch") {
      await engine.tick();
    } else {
      const job = await engine.getJob(jobId);
      if (!job) throw new Error(`job not found: ${jobId}`);
      await engine.runJobNow(job);
    }
    process.stdout.write(`DONE ${process.pid}\n`);
    return;
  }

  if (mode === "elect") {
    engine.startDaemon({ tickMs: 1000, electionMs });
    let reported: boolean | null = null;
    // A ref'd interval: every engine timer is unref'd, so without this the
    // child would exit as soon as main() resolves.
    const poll = setInterval(() => {
      // `running` (this process's own local view), deliberately: the pre-fix
      // engine set it to true in EVERY process, which is the bug. Post-fix it
      // is true only in the elected owner.
      const owner = engine.getDaemonStatus().running === true;
      if (owner === reported) return;
      reported = owner;
      process.stdout.write(`${owner ? "OWNER" : "LOSER"} ${process.pid}\n`);
    }, 25);
    setTimeout(() => {
      clearInterval(poll);
      engine.stopDaemon();
    }, lifetimeMs);
    return;
  }

  throw new Error(`unknown child mode: ${mode}`);
}

void main().catch((err) => {
  process.stderr.write(`CHILD ERROR ${process.pid}: ${(err as Error).stack}\n`);
  process.exit(1);
});
