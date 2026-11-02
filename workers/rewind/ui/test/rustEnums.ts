// Reads a serde enum out of the Rust core's source, with each variant as the core writes it in JSON.
// It knows what the core's enums use (`rename_all`, `tag`, a variant's `rename`), and throws when an
// enum is missing, so renaming one in the core fails the test.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

export type RustEnum = { name: string; tag?: string; values: string[] }

const words = (name: string): string[] => name.split(/(?=[A-Z])/).map((word) => word.toLowerCase())

const RENAME_ALL: Record<string, (name: string) => string> = {
  lowercase: (name) => name.toLowerCase(),
  UPPERCASE: (name) => name.toUpperCase(),
  snake_case: (name) => words(name).join('_'),
  SCREAMING_SNAKE_CASE: (name) => words(name).join('_').toUpperCase(),
  'kebab-case': (name) => words(name).join('-'),
  camelCase: (name) => name[0].toLowerCase() + name.slice(1),
  PascalCase: (name) => name,
}

function serdeArg(attributes: string, key: string): string | undefined {
  return new RegExp(`#\\[serde\\([^\\]]*\\b${key}\\s*=\\s*"([^"]+)"`).exec(attributes)?.[1]
}

const DEPTH_STEP: Record<string, number> = { '{': 1, '}': -1 }

/** The text between the brace after `start` and the brace that closes it. */
function braced(source: string, start: number): string {
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    depth += DEPTH_STEP[source[i]] ?? 0
    if (depth === 0) {
      return source.slice(open + 1, i)
    }
  }

  throw new Error('an enum body never closes')
}

/** The variants at the top level of an enum body, each with the attributes right above it. */
function variants(body: string): { name: string; attributes: string }[] {
  const found: { name: string; attributes: string }[] = []
  let depth = 0
  let attributes = ''
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    const atTop = depth === 0
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
    if (!atTop || line === '') {
      continue
    }

    if (line.startsWith('#[')) {
      attributes += `${line}\n`
      continue
    }

    const name = /^([A-Z][A-Za-z0-9]*)\b/.exec(line)?.[1]
    if (name) {
      found.push({ name, attributes })
    }

    attributes = ''
  }

  return found
}

/** The serde enum `name` in the core file `file`, with each variant as the core writes it in JSON. */
export function rustEnum(file: string, name: string): RustEnum {
  const source = readFileSync(path.join(CORE_SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const match = new RegExp(`((?:^[ \\t]*(?:#\\[[^\\n]*\\]|///[^\\n]*)\\n)*)[ \\t]*pub enum ${name}\\b`, 'm').exec(source)
  if (!match) {
    throw new Error(`no enum ${name} in ${file}`)
  }

  const attributes = match[1]
  const renameAll = serdeArg(attributes, 'rename_all') ?? 'PascalCase'
  const rename = RENAME_ALL[renameAll]
  if (!rename) {
    throw new Error(`${name} uses rename_all = "${renameAll}", which this reader does not know`)
  }

  const values = variants(braced(source, match.index + match[0].length)).map((v) => serdeArg(v.attributes, 'rename') ?? rename(v.name))
  return { name, tag: serdeArg(attributes, 'tag'), values }
}
