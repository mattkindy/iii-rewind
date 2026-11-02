/**
 * The line above a fork's calls that says where it ended and how it got
 * there, such as "Booked · 3 live · email::send filled from run 849b62e". The
 * parts after the ending come from the model; this file only says the ending
 * the way people would.
 */
import { Route } from 'lucide-react'
import { outputStatus } from '../model/appOutput'
import type { Line } from '../model/lines'
import { outcomeLook } from '../model/outcomes'
import { pathParts } from '../model/path'

// A run that returns a status reads as that status, capitalized: "Booked".
function ending(line: Line): string {
  const status = line.outcome.state === 'done' ? outputStatus(line.outcome.output) : undefined
  if (status) {
    return status[0].toUpperCase() + status.slice(1)
  }

  return outcomeLook(line.outcome).short
}

export function PathLine({ line }: { line: Line }) {
  return (
    <p className="rw-path-line">
      <Route aria-hidden />
      <span className="rw-path-outcome" data-tone={outcomeLook(line.outcome).tone}>
        {ending(line)}
      </span>
      {pathParts(line).map((part) => (
        <span key={part}>· {part}</span>
      ))}
    </p>
  )
}
