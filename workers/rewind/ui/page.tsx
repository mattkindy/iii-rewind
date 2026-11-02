/**
 * The script asset Rewind injects into the iii console. It registers the page
 * `rewind`, which the workspace opens as the `ext:rewind` screen and which
 * renders alone at `#/worker/rewind/rewind`, plus a palette row that opens it
 * while it is closed. It returns a disposer that removes both, which the
 * console runs on hot reload and when Rewind disconnects.
 */
import type { Host } from '@iii-dev/console-ui'
import { PAGE_ID, RewindPage } from './src/components/rewindPage'

export default function setup(host: Host): () => void {
  const removePage = host.pages.register({
    id: PAGE_ID,
    title: 'Rewind',
    render: (props) => <RewindPage host={host} {...props} />,
  })

  const removeCommands = host.commands?.register(PAGE_ID, [
    {
      id: 'open',
      title: 'Open Rewind',
      detail: 'Replay and fork recorded runs',
      keywords: ['replay', 'fork', 'debug', 'recover'],
      run: () => host.panels?.open({ pageId: PAGE_ID }),
    },
  ])

  return () => {
    removeCommands?.()
    removePage()
  }
}
