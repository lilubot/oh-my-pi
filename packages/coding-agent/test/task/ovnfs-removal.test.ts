import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as client from "../../src/ovnfs/client";
import * as daemon from "../../src/ovnfs/daemon";
import { OVNFS_CHECKOUT_FILE, ovnfsWorkspace, releaseOvnfsCheckout } from "../../src/task/ovnfs";

let root: string;
const originalThreshold = process.env.OMP_OVNFS_RM_PSI_MAX;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ovnfs-removal-"));
	vi.spyOn(daemon, "startDaemon").mockResolvedValue({ socket: "/fake", mount: root });
	vi.spyOn(fs, "readFile").mockRejectedValue(new Error("ENOENT"));
	process.env.OMP_OVNFS_RM_PSI_MAX = "10";
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalThreshold === undefined) delete process.env.OMP_OVNFS_RM_PSI_MAX;
	else process.env.OMP_OVNFS_RM_PSI_MAX = originalThreshold;
	await fs.rm(root, { recursive: true, force: true });
});

async function recordedCheckout(name: string): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(dir);
	await Bun.write(path.join(dir, OVNFS_CHECKOUT_FILE), JSON.stringify({ command: "ovnfs", checkout: name }));
	return dir;
}

describe("ovnfs removal admission", () => {
	it("serializes eight mixed cleanup/releases and isolates a failed removal", async () => {
		let active = 0;
		let maximum = 0;
		let completed = 0;
		vi.spyOn(client, "callSocket").mockImplementation(async (_socket, op, args) => {
			if (op === "new") return { checkout: { path: root } } as never;
			expect(op).toBe("rm");
			maximum = Math.max(maximum, ++active);
			const gate = Promise.withResolvers<void>();
			queueMicrotask(gate.resolve);
			await gate.promise;
			active--;
			completed++;
			if ("checkout" in args && args.checkout === "fail") throw new Error("remove failed");
			return {} as never;
		});
		const workspace = await ovnfsWorkspace("ovnfs")(root, "Cleanup");
		const dirs = await Promise.all(["one", "fail", "three", "four", "five", "six", "seven"].map(recordedCheckout));
		const results = await Promise.allSettled([workspace.cleanup(), ...dirs.map(releaseOvnfsCheckout)]);
		expect(maximum).toBe(1);
		expect(completed).toBe(8);
		expect(results.map(result => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
			"rejected",
			"fulfilled",
			"fulfilled",
			"fulfilled",
			"fulfilled",
			"fulfilled",
		]);
	});

	it.skipIf(process.platform !== "linux")("waits for high PSI to drop before sending rm", async () => {
		const events: string[] = [];
		vi.spyOn(fs, "readFile")
			.mockResolvedValueOnce("some avg10=10.00 avg60=0.00\n")
			.mockResolvedValueOnce("some avg10=9.99 avg60=0.00\n");
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			events.push("wait");
		});
		vi.spyOn(client, "callSocket").mockImplementation(async () => {
			events.push("rm");
			return {} as never;
		});
		await releaseOvnfsCheckout(await recordedCheckout("pressure"));
		expect(events).toEqual(["wait", "rm"]);
	});

	it("proceeds immediately when PSI is absent", async () => {
		const sleep = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const call = vi.spyOn(client, "callSocket").mockResolvedValue({});
		await releaseOvnfsCheckout(await recordedCheckout("absent"));
		expect(sleep).not.toHaveBeenCalled();
		expect(call).toHaveBeenCalledTimes(1);
	});

	it.skipIf(process.platform !== "linux")("uses the configured PSI threshold and ignores malformed readings", async () => {
		process.env.OMP_OVNFS_RM_PSI_MAX = "20";
		vi.spyOn(fs, "readFile")
			.mockResolvedValueOnce("some avg10=19.00 avg60=0.00\n")
			.mockResolvedValueOnce("unavailable\n");
		const sleep = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const call = vi.spyOn(client, "callSocket").mockResolvedValue({});
		await releaseOvnfsCheckout(await recordedCheckout("override"));
		await releaseOvnfsCheckout(await recordedCheckout("malformed"));
		expect(sleep).not.toHaveBeenCalled();
		expect(call).toHaveBeenCalledTimes(2);
	});

	it.skipIf(process.platform !== "linux")("bounds sustained pressure to sixty one-second waits", async () => {
		vi.spyOn(fs, "readFile").mockResolvedValue("some avg10=90.00 avg60=0.00\n");
		const sleep = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		vi.spyOn(client, "callSocket").mockResolvedValue({});
		await releaseOvnfsCheckout(await recordedCheckout("bounded"));
		expect(sleep).toHaveBeenCalledTimes(60);
	});
});
