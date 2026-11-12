import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

for (const script of ["build-seen.mjs", "collect.mjs", "render.mjs"]) {
  const r = spawnSync(process.execPath, [path.join(HERE, script)].concat(args), { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[daily] " + script + " 失败，退出码 " + r.status);
    process.exit(r.status || 1);
  }
}
