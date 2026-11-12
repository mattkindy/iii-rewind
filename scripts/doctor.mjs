/**
 * Checks that this machine can run the project, and says what to install when it can't.
 * Compose runs it before anything else starts, so `iii compose --up` stops at once with a
 * clear message instead of failing minutes later inside a build. It installs nothing.
 *
 * Run it on its own with `npm run doctor` or `node scripts/doctor.mjs`. Plain Node, no packages,
 * so it works before any `npm install`.
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

const III_VERSION = '0.26.0'
const MIN_NODE_MAJOR = 20
const PORTS = [{ port: 49335, what: 'the fake holidays API and email provider' }, { port: 3133, what: 'iii\'s console and its proxy' }]

function versionOf(command, args = ['--version']) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

const problems = []

const iii = versionOf('iii')
if (!iii) {
  problems.push('iii is not on PATH. Install it from https://iii.dev, then run `iii update`.')
} else if (!iii.includes(III_VERSION)) {
  problems.push(`iii is ${iii}; this project is built for ${III_VERSION}. Run \`iii update\`.`)
}

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < MIN_NODE_MAJOR) {
  problems.push(`Node is ${process.versions.node}; it needs ${MIN_NODE_MAJOR} or newer.`)
}

if (!versionOf('uv')) {
  problems.push('uv is not on PATH. It provides Python 3.11 for the tools worker: https://docs.astral.sh/uv/')
}

if (!versionOf('cargo')) {
  problems.push('cargo is not on PATH. Rewind is built from source: https://rustup.rs')
}

for (const { port, what } of PORTS) {
  if (!(await portFree(port))) {
    problems.push(`Port ${port} is taken; ${what} use it. If an earlier run is still up, stop it with \`npm run stop\`.`)
  }
}

if (problems.length > 0) {
  console.error('This machine is missing something the project needs:\n')
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }

  process.exit(1)
}

console.log('doctor: iii, Node, uv and cargo are present, and the ports are free')
