/**
 * Kills one of this project's workers with SIGKILL, for the failure demo. Compose restarts it.
 *
 * Run from the repo root, while traffic is flowing:
 *   npx tsx scripts/kill.ts tools
 *   npx tsx scripts/kill.ts agent experiments/durable/stack/worker-compose.yaml
 *
 * It asks `iii ps --json` for the worker with that name in the compose file, this project's by
 * default, so a worker with the same name in another project is never touched. Set III_BIN to
 * use a particular iii binary.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

type IiiProcess = { pid: number; kind: string; name: string; compose_file: string | null; command: string }

const [name, composeArg = 'worker-compose.yaml'] = process.argv.slice(2)
if (!name) {
  console.error('usage: npx tsx scripts/kill.ts <worker name> [compose file]')
  process.exit(2)
}

const composeFile = resolve(process.cwd(), composeArg)
const listing = execFileSync(process.env.III_BIN ?? 'iii', ['ps', '--json'], { encoding: 'utf8' })
const processes = JSON.parse(listing) as IiiProcess[]

// A node worker also shows its esbuild helper under the same name, so take the one compose started.
const target = processes.find((p) => p.kind === 'worker' && p.name === name && p.compose_file === composeFile && !p.command.includes('esbuild'))
if (!target) {
  console.error(`no running worker named ${name} for ${composeFile}`)
  process.exit(1)
}

process.kill(target.pid, 'SIGKILL')
console.log(`killed ${name} (pid ${target.pid}) with SIGKILL`)
