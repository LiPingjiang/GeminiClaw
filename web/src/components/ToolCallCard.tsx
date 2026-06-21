import { useState } from 'react'
import { ChevronRight, ChevronDown, Wrench, CheckCircle, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ToolCallCardProps {
  name: string
  input?: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
}

export default function ToolCallCard({ name, input, output, status }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="my-2 mx-0 border border-gray-700 rounded-lg overflow-hidden text-xs font-mono">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-750 text-left"
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Wrench size={11} className="text-blue-400 shrink-0" />
        <span className="text-gray-300 flex-1 truncate">{name}</span>
        {status === 'running' && <Loader size={11} className="text-yellow-400 animate-spin shrink-0" />}
        {status === 'done' && <CheckCircle size={11} className="text-green-400 shrink-0" />}
        {status === 'error' && (
          <span className="text-red-400 shrink-0">✗</span>
        )}
      </button>
      {expanded && (
        <div className={cn('grid divide-x divide-gray-700', output !== undefined ? 'grid-cols-2' : 'grid-cols-1')}>
          <div className="p-3 bg-gray-900">
            <div className="text-gray-500 mb-1.5 font-sans text-[10px] uppercase tracking-wider">Input</div>
            <pre className="text-gray-300 whitespace-pre-wrap break-all text-[11px]">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {output !== undefined && (
            <div className="p-3 bg-gray-900">
              <div className="text-gray-500 mb-1.5 font-sans text-[10px] uppercase tracking-wider">Output</div>
              <pre className="text-gray-300 whitespace-pre-wrap break-all text-[11px]">
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
