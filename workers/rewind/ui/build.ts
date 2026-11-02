/**
 * Builds Rewind's console page into dist/page.js and dist/styles.css.
 *
 * Plain esbuild, so the build works outside the workers monorepo. The six
 * specifiers the console's import map serves stay external, matched exactly:
 * esbuild's own `external` list would also externalize the
 * `@iii-dev/console-ui/hooks` and `/format` subpaths, which the import map does
 * not serve, so they have to be bundled. After the bundle, the same checks the
 * shared driver runs: every CSS rule scoped to `[data-iii-ui="rewind"]`, no
 * unknown design token, the 8 MiB asset cap, and the design lint in strict mode.
 *
 * Run from workers/rewind/ui: npx tsx build.ts (or npm run build, which type
 * checks first). Pass --watch to rebuild on save without the lint.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertScoped, checkTokens, workerUiExternalsPlugin } from '@iii-dev/console-ui/build-worker-ui'
import { formatLint, lintWorkerUi } from '@iii-dev/console-ui/lint-worker-ui'
import esbuild from 'esbuild'

const SCOPE = 'rewind'
const ASSET_CAP_BYTES = 8 * 1024 * 1024
const root = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

function checkOutputs(outputs: string[]): void {
  const files = outputs.map((file) => [file, readFileSync(path.resolve(root, file), 'utf8')] as const)
  for (const [file, text] of files) {
    if (statSync(path.resolve(root, file)).size >= ASSET_CAP_BYTES) {
      throw new Error(`${file} is over the console's 8 MiB asset cap`)
    }

    if (file.endsWith('.css')) {
      assertScoped(text, { scope: SCOPE, file })
    }
  }

  checkTokens(files, { strict: true })
}

function lint(): void {
  const result = lintWorkerUi({ root, scope: SCOPE, strict: true })
  process.stdout.write(`${formatLint(result, { strict: true })}\n`)
  if (result.errors.length > 0) {
    throw new Error(`${result.errors.length} design rule finding(s), listed above`)
  }
}

const checks: esbuild.Plugin = {
  name: 'rewind-ui-checks',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0 || !result.metafile) {
        return
      }

      try {
        checkOutputs(Object.keys(result.metafile.outputs))
        if (!watch) {
          lint()
        }
      } catch (error) {
        process.stderr.write(`\n${(error as Error).message}\n`)
        if (!watch) {
          process.exit(1)
        }
      }
    })
  },
}

const options: esbuild.BuildOptions = {
  absWorkingDir: root,
  entryPoints: ['page.tsx', 'styles.css'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  minify: !watch,
  metafile: true,
  logLevel: 'info',
  plugins: [workerUiExternalsPlugin(), checks],
}

if (watch) {
  const context = await esbuild.context(options)
  await context.watch()
} else {
  const result = await esbuild.build(options)
  for (const [file, info] of Object.entries(result.metafile?.outputs ?? {})) {
    const external = [...new Set(info.imports.filter((i) => i.external).map((i) => i.path))]
    process.stdout.write(`${file} ${info.bytes} bytes, external: ${JSON.stringify(external)}\n`)
  }
}
