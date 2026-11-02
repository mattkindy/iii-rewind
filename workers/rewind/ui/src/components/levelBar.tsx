/**
 * The strip above every level below the landing: Back, the breadcrumb of where
 * the person is, and that level's own tools at the end. Back always goes one
 * level up, so it is the same button on every level and at every width.
 */
import { Breadcrumb, type BreadcrumbItem, IconButton, Toolbar } from '@iii-dev/console-ui'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

export function LevelBar({ crumbs, onBack, end }: { crumbs: BreadcrumbItem[]; onBack: () => void; end?: ReactNode }) {
  return (
    <Toolbar aria-label="Where you are" className="rw-toolbar" end={end}>
      <IconButton label="Back" onClick={onBack}>
        <ArrowLeft aria-hidden />
      </IconButton>
      <Breadcrumb items={crumbs} className="rw-crumbs" />
    </Toolbar>
  )
}
