import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PortableFile } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { archiveBoatWorkspaceCommand } from "./boat-sandbox.js";
import { readWorkspaceArchive } from "./workspace-archive.js";

/** The export script needs GNU find and tar, as the Boat image has; macOS ships BSD ones. */
function gnu(tool: string): boolean {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes("GNU");
}
const gnuTools = gnu("find") && gnu("tar");
const root = process.getuid?.() === 0;

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-boat-archive-"));
  temporary.push(dir);
  const home = path.join(dir, "rakazo-home");
  await mkdir(home);
  const put = async (name: string, content: string, mode = 0o644) => {
    const target = path.join(home, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    await chmod(target, mode);
  };
  return { dir, home, put, archive: path.join(dir, "workspace.tar.gz") };
}

/** Runs the export's archive script against `home`, with `tar` optionally wrapped. */
function archiveScript(home: string, archive: string, tarWrapper?: string) {
  const env = { ...process.env };
  if (tarWrapper) env.PATH = `${tarWrapper}:${env.PATH}`;
  return spawnSync("bash", ["-c", archiveBoatWorkspaceCommand(archive, home)], {
    encoding: "utf8",
    env,
  });
}

async function read(archive: string): Promise<[string, string, boolean][]> {
  const files: PortableFile[] = [];
  for await (const file of readWorkspaceArchive(createReadStream(archive))) files.push(file);
  return files
    .map((file): [string, string, boolean] => [
      file.path,
      Buffer.from(file.content).toString(),
      file.executable ?? false,
    ])
    .sort(([a], [b]) => a.localeCompare(b));
}

describe.skipIf(!gnuTools)("Boat workspace archive script", () => {
  it("archives regular files, hard links as copies, and no caches or links", async () => {
    const { dir, home, put, archive } = await workspace();
    await put("notes.txt", "notes");
    await put("bin/tool", "#!/bin/sh\n", 0o755);
    await put("with space/new\nline.md", "odd");
    await put("unicode/café 🙂.txt", "unicode");
    await put("-rf", "dash");
    await put("--checkpoint-action=exec=touch PWNED", "option");
    await put(".browser-profiles/chrome/Default/Cache/data_0", "cache");
    await put(".browser-profiles/chrome/Default/Code Cache/js", "cache");
    await put(".browser-profiles/chrome/Default/Cookies", "cookies");
    await mkdir(path.join(home, "empty-dir"));
    await link(path.join(home, "notes.txt"), path.join(home, "hard-link.txt"));
    await symlink("/etc/passwd", path.join(home, "escape"));

    const result = archiveScript(home, archive);

    expect(result.status).toBe(0);
    expect(await read(archive)).toEqual([
      ["--checkpoint-action=exec=touch PWNED", "option", false],
      ["-rf", "dash", false],
      [".browser-profiles/chrome/Default/Cookies", "cookies", false],
      ["bin/tool", "#!/bin/sh\n", true],
      ["hard-link.txt", "notes", false],
      ["notes.txt", "notes", false],
      ["unicode/café 🙂.txt", "unicode", false],
      ["with space/new\nline.md", "odd", false],
    ]);
    // The script leaves only the archive, which the adapter removes after downloading it.
    expect(execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n").sort()).toEqual(
      ["", "rakazo-home", "workspace.tar.gz"].sort(),
    );
  });

  it("archives an empty workspace", async () => {
    const { home, archive } = await workspace();
    expect(archiveScript(home, archive).status).toBe(0);
    expect(await read(archive)).toEqual([]);
  });

  it("keeps the rest of the workspace when a file vanishes before tar reads it", async () => {
    const { dir, home, put, archive } = await workspace();
    await put("kept.txt", "kept");
    await put("vanishing.txt", "gone");
    const wrapper = path.join(dir, "bin");
    await mkdir(wrapper);
    const realTar = execFileSync("bash", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
    await writeFile(
      path.join(wrapper, "tar"),
      `#!/bin/sh\nrm -f -- ${JSON.stringify(path.join(home, "vanishing.txt"))}\nexec ${JSON.stringify(realTar)} "$@"\n`,
      { mode: 0o755 },
    );

    const result = archiveScript(home, archive, wrapper);

    expect(result.status).toBe(0);
    expect(await read(archive)).toEqual([["kept.txt", "kept", false]]);
  });

  it.skipIf(root)("fails on a file it cannot read instead of leaving it out", async () => {
    const { home, put, archive } = await workspace();
    await put("kept.txt", "kept");
    await put("secret.txt", "secret", 0o000);

    expect(archiveScript(home, archive).status).toBe(3);
  });
});
