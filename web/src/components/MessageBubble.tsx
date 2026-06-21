import ReactMarkdown from 'react-markdown'
import type { TuiEvent } from '@/lib/api'

interface MessageBubbleProps {
  event: TuiEvent & ({ kind: 'user_message' } | { kind: 'response' } | { kind: 'system' } | { kind: 'error' })
  streaming?: boolean
}

export default function MessageBubble({ event, streaming }: MessageBubbleProps) {
  if (event.kind === 'user_message') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[70%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed">
          {event.content}
        </div>
      </div>
    )
  }

  if (event.kind === 'response') {
    return (
      <div className="flex justify-start mb-4">
        <div className="max-w-[80%] bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed">
          {streaming ? (
            <span className="text-gray-100">
              {event.content}
              <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse ml-0.5 align-middle" />
            </span>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown>{event.content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (event.kind === 'system') {
    return (
      <div className="flex justify-center mb-2">
        <span className="text-xs text-gray-500 px-3 py-1 rounded-full bg-gray-900 border border-gray-800">
          {event.message}
        </span>
      </div>
    )
  }

  if (event.kind === 'error') {
    return (
      <div className="flex justify-center mb-2">
        <span className="text-xs text-red-400 px-3 py-1 rounded-full bg-red-950 border border-red-800">
          Error: {event.message}
        </span>
      </div>
    )
  }

  return null
}
