/**
 * Module loader hooks that wrap the functions someone asked to trace. Node
 * runs these off the main thread, after tsx has turned TypeScript into
 * JavaScript, so the source here is what Node will run.
 *
 * tsx writes a whole module on one line with a source map, so nothing before
 * the end may change length. The traced declaration gets a name of the same
 * length, and a declaration with the original name goes after the last line
 * of code. It is hoisted like the original, so code anywhere in the module
 * calls the traced function, which calls the wrapper the preload set up.
 */
import { fileURLToPath } from 'node:url'

let targets = []

export async function initialize(data) {
  targets = data.targets
}

// A declaration can follow any character that can't be part of a name.
function declaration(name) {
  return new RegExp(`(^|[^\\w$.])((?:export\\s+)?(?:async\\s+)?function(?:\\s*\\*)?\\s+)${name}(?=\\s*[<(])`)
}

function untracedName(name) {
  return `${name.slice(0, -1)}$`
}

function traced(name, id, exported) {
  const call = `globalThis[Symbol.for('rewind.trace')](${JSON.stringify(id)}, ${untracedName(name)})`
  const exporting = exported ? `export { ${name} };` : ''
  return `function ${name}(...args) { ${name}.rewindTraced ??= ${call}; return ${name}.rewindTraced.apply(this, args) }${exporting}`
}

function wrap(source, { name, id }) {
  const match = declaration(name).exec(source)
  if (!match || source.includes(untracedName(name))) {
    return undefined
  }

  const [found, before, keywords] = match
  const renamed = `${before}${keywords}${untracedName(name)}`
  return { source: source.slice(0, match.index) + renamed + source.slice(match.index + found.length), added: traced(name, id, keywords.startsWith('export')) }
}

/** The source with the added declarations after the code and before the source map comment. */
function withAdded(source, added) {
  const mapAt = source.lastIndexOf('\n//# sourceMappingURL=')
  if (mapAt < 0) {
    return `${source}\n${added}\n`
  }

  return `${source.slice(0, mapAt)}\n${added}${source.slice(mapAt)}`
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!url.startsWith('file:') || loaded.source === undefined || loaded.source === null) {
    return loaded
  }

  const file = fileURLToPath(url)
  const wanted = targets.filter((target) => target.file === file)
  if (wanted.length === 0) {
    return loaded
  }

  let source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8')
  let added = ''
  for (const target of wanted) {
    const wrapped = wrap(source, target)
    if (!wrapped) {
      process.stderr.write(`rewind preload: no function ${target.name} to trace in ${file}\n`)
      continue
    }

    source = wrapped.source
    added += wrapped.added
  }

  return { ...loaded, source: withAdded(source, added) }
}
