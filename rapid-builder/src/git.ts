import { rename, rm } from "node:fs/promises";
import { type Log, run } from "./run.ts";

/**
 * Synchronize a working tree to one commit without retaining the repository's
 * complete history. Rapid builds an immutable commit, not a Git branch.
 */
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
		// Initialize an empty repository rather than cloning the entire history.
		// Atomic rename prevents a failed initialization becoming the live checkout.
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
	await git("remote", "set-url", "origin", url);
	// Fetch only the requested commit. --depth=1 also limits subsequent fetches
	// for repositories that were originally cloned with full history.
	await git("fetch", "--no-tags", "--depth=1", "origin", commit);
	await git("checkout", "--detach", "--force", "FETCH_HEAD");
	await git("submodule", "sync", "--recursive");
	await git("submodule", "update", "--init", "--recursive", "--force", "--depth=1");
	await git("submodule", "foreach", "--recursive", "git", "reset", "--hard");
	await git("clean", "-xffd");
	await git("submodule", "foreach", "--recursive", "git", "clean", "-xffd");
}
