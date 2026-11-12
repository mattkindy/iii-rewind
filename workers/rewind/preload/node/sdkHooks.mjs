/**
 * Module loader hooks that hand the worker's own `import 'iii-sdk'` a module of the preload's,
 * which exports everything the SDK does and wraps what registerWorker returns with durableWorker.
 * The SDK's worker class isn't exported and sets `call` on each instance, so the instance is
 * the only place to wrap it. The preload's own imports of the SDK use a file URL, which these
 * hooks leave alone.
 */
// No file has this URL: load() below writes the module's source.
const WRAPPER = new URL('./durable-sdk', import.meta.url).href
const DURABLE = new URL('./durable.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (specifier !== 'iii-sdk') {
    return resolved
  }

  return { ...resolved, url: `${WRAPPER}?sdk=${encodeURIComponent(resolved.url)}`, shortCircuit: true }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith(`${WRAPPER}?`)) {
    return nextLoad(url, context)
  }

  const sdk = JSON.stringify(new URL(url).searchParams.get('sdk'))
  const source = [
    `export * from ${sdk}`,
    `import { registerWorker as register, InvocationError } from ${sdk}`,
    `import { durableWorker } from ${JSON.stringify(DURABLE)}`,
    'export const registerWorker = (...args) => durableWorker(register(...args), InvocationError)',
    '',
  ].join('\n')
  return { format: 'module', source, shortCircuit: true }
}
