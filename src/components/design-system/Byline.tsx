import React, { Children, isValidElement } from 'react'
import ThemedText from './ThemedText.js'

type Props = {
  children: React.ReactNode
}

/**
 * Joins children with a middot separator (" · ") for inline metadata display.
 */
export function Byline({ children }: Props): React.ReactNode {
  const validChildren = Children.toArray(children)

  if (validChildren.length === 0) {
    return null
  }

  return (
    <>
      {validChildren.map((child, index) => (
        <React.Fragment
          key={isValidElement(child) ? (child.key ?? index) : index}
        >
          {index > 0 && <ThemedText dimColor> · </ThemedText>}
          {child}
        </React.Fragment>
      ))}
    </>
  )
}
