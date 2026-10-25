import { rename, rm } from "node:fs/promises";
import { type Log, run } from "./run.ts";

/** Synchronize a checkout without downloading the origin's entire history. */
export async function syncGitRepo(
	log: Log,
	gitDir: string,
	url: string,
	commit: string,
): Promise<void> {
	const isRepo = await run("git", ["-C", gitDir, "rev-parse", "--git-dir"], {
		check: false,
	});
	if (isRepo.exitCode !== 0) {
		const tmpDir = `${gitDir}.tmp`;
		await rm(tmpDir, { recursive: true, force: true });
		try {
			await run("git", ["init", tmpDir], { log });
			await run("git", ["-C", tmpDir, "remote", "add", "origin", url], { log });
			await rename(tmpDir, gitDir);
		} catch (err) {
			await rm(tmpDir, { recursive: true, force: true });
			throw err;
		}
	}

	const git = (...args: string[]) => run("git", args, { cwd: gitDir, log });
	const previous = await run("git", ["rev-parse", "--verify", "HEAD"], {
		cwd: gitDir,
		check: false,
	});
	await git("remote", "set-url", "origin", url);
	await git("fetch", "--no-tags", "--depth=1", "origin", commit);

	if (previous.exitCode === 0 && previous.stdout.trim() !== commit) {
		const oldCommit = previous.stdout.trim();
		// A shallow boundary can hide the previous build from rapid-buildgit.
		// Deepen until it is an ancestor. If it is not an ancestor (e.g. a
		// force-push), fetch the full reachable history for a safe cold build.
		let depth = 1;
		for (let attempt = 0; attempt < 8; attempt++) {
			const ancestor = await run(
				"git",
				["merge-base", "--is-ancestor", oldCommit, "FETCH_HEAD"],
				{ cwd: gitDir, check: false },
			);
			if (ancestor.exitCode === 0) break;
			const shallow = await run("git", ["rev-parse", "--is-shallow-repository"], {
				cwd: gitDir,
			});
			if (shallow.stdout.trim() !== "true") break;
			depth *= 2;
			await git("fetch", "--no-tags", `--depth=${depth}`, "origin", commit);
			if (attempt === 7) {
				// The previous commit may be on a different branch. A shallow
				// repository can remain shallow forever when fetching that branch.
				// Never loop indefinitely on a diverged history.
				await git("fetch", "--no-tags", "--unshallow", "origin", commit);
			}
		}
	}

	await git("checkout", "--detach", "--force", "FETCH_HEAD");
	await git("submodule", "sync", "--recursive");
	await git("submodule", "update", "--init", "--recursive", "--force", "--depth=1");
	await git("submodule", "foreach", "--recursive", "git", "reset", "--hard");
	await git("clean", "-xffd");
	await git("submodule", "foreach", "--recursive", "git", "clean", "-xffd");
}

/** Drop ancestry after a successful build; the current commit stays available. */
export async function compactGitRepo(log: Log, gitDir: string, commit: string): Promise<void> {
	const git = (...args: string[]) => run("git", args, { cwd: gitDir, log });
	await git("fetch", "--no-tags", "--depth=1", "origin", commit);
	await git("reflog", "expire", "--expire=now", "--all");
	await git("gc", "--prune=now");
}
