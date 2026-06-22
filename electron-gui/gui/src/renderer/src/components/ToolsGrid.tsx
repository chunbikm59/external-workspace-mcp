import { useState } from 'react'
import { TOOL_GROUPS } from '../../../shared/types'
import type { ToolMetadata, ToolParamMetadata } from '../../../shared/types'
import toolMetadataList from '../../../shared/toolMetadata.json'

interface Props {
  disabledTools: string[]
  readonlyMode: boolean
  onChange: (disabledTools: string[]) => void
}

const TOOL_METADATA: Record<string, ToolMetadata> = Object.fromEntries(
  (toolMetadataList as ToolMetadata[]).map(t => [t.name, t]),
)

function formatParamType(param: ToolParamMetadata): string {
  if (param.enumValues && param.enumValues.length > 0) {
    return param.enumValues.map(v => JSON.stringify(v)).join(' | ')
  }
  return param.type
}

function ParamTable({ params }: { params: ToolParamMetadata[] }) {
  if (params.length === 0) {
    return <p className="text-xs italic" style={{ color: '#aaa' }}>此工具沒有輸入參數。</p>
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr style={{ borderBottom: '1px solid #e2e0db' }}>
          <th className="text-left font-medium py-1 pr-2" style={{ color: '#888' }}>參數</th>
          <th className="text-left font-medium py-1 pr-2" style={{ color: '#888' }}>類型</th>
          <th className="text-left font-medium py-1 pr-2" style={{ color: '#888' }}>必填</th>
          <th className="text-left font-medium py-1 pr-2" style={{ color: '#888' }}>預設值</th>
          <th className="text-left font-medium py-1" style={{ color: '#888' }}>說明</th>
        </tr>
      </thead>
      <tbody>
        {params.map(param => (
          <tr key={param.name} style={{ borderBottom: '1px solid #ececec' }}>
            <td className="py-1.5 pr-2 font-mono whitespace-nowrap align-top" style={{ color: '#333' }}>
              {param.name}
            </td>
            <td className="py-1.5 pr-2 font-mono whitespace-nowrap align-top" style={{ color: '#6b7280' }}>
              {formatParamType(param)}
            </td>
            <td className="py-1.5 pr-2 align-top" style={{ color: param.required ? '#ef4444' : '#aaa' }}>
              {param.required ? '是' : '否'}
            </td>
            <td className="py-1.5 pr-2 font-mono align-top" style={{ color: '#aaa' }}>
              {param.default !== undefined ? JSON.stringify(param.default) : '—'}
            </td>
            <td className="py-1.5 align-top" style={{ color: '#666' }}>
              {param.description ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ToolCheckbox({
  name,
  disabled: forceDisabled,
  disabledTools,
  onChange,
  hint,
}: {
  name: string
  disabled: boolean
  disabledTools: string[]
  onChange: (name: string, checked: boolean) => void
  hint?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const isUserDisabled = disabledTools.includes(name)
  const isEffectivelyOff = forceDisabled || isUserDisabled
  const metadata = TOOL_METADATA[name]

  return (
    <div className={forceDisabled ? 'opacity-40' : ''}>
      <div className="flex items-start gap-2 group">
        <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-0">
          <input
            type="checkbox"
            checked={!isEffectivelyOff}
            disabled={forceDisabled}
            onChange={e => onChange(name, e.target.checked)}
            className="mt-0.5 accent-emerald-500 cursor-pointer"
          />
          <div className="min-w-0">
            <span className="text-sm font-mono transition-colors truncate block" style={{ color: '#333' }}>
              {name}
            </span>
            {hint && <span className="text-xs text-amber-500 mt-0.5 block">{hint}</span>}
          </div>
        </label>
        {metadata && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="text-xs px-1 rounded transition-colors flex-shrink-0"
            style={{ color: '#999' }}
            title={expanded ? '收合說明' : '展開查看說明與參數'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
      </div>
      {expanded && metadata && (
        <div
          className="mt-1.5 mb-2 ml-6 rounded-lg px-3 py-2"
          style={{ background: '#fafaf8', border: '1px solid #e2e0db' }}
        >
          <p className="text-xs mb-2" style={{ color: '#555' }}>{metadata.description}</p>
          <ParamTable params={metadata.params} />
        </div>
      )}
    </div>
  )
}

export function ToolsGrid({ disabledTools, readonlyMode, onChange }: Props) {
  const toggle = (name: string, checked: boolean) => {
    if (checked) {
      onChange(disabledTools.filter(t => t !== name))
    } else {
      if (!disabledTools.includes(name)) onChange([...disabledTools, name])
    }
  }

  return (
    <div className="space-y-4">
      {/* Read-only tools */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#555' }}>
          唯讀工具
        </h4>
        <div className="grid grid-cols-1 gap-y-1">
          {TOOL_GROUPS.readonly.map(name => (
            <ToolCheckbox
              key={name}
              name={name}
              disabled={false}
              disabledTools={disabledTools}
              onChange={toggle}
            />
          ))}
        </div>
      </div>

      {/* Write tools */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2" style={{ color: '#555' }}>
          寫入工具
          {readonlyMode && (
            <span className="text-xs text-amber-500 font-normal normal-case tracking-normal">
              （唯讀模式下全部禁用）
            </span>
          )}
        </h4>
        <div className="grid grid-cols-1 gap-y-1">
          {TOOL_GROUPS.write.map(name => (
            <ToolCheckbox
              key={name}
              name={name}
              disabled={readonlyMode}
              disabledTools={disabledTools}
              onChange={toggle}
            />
          ))}
        </div>
      </div>

      {/* Special tools */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#555' }}>
          特殊工具
        </h4>
        <div className="grid grid-cols-1 gap-y-1">
          {TOOL_GROUPS.special.map(name => (
            <ToolCheckbox
              key={name}
              name={name}
              disabled={false}
              disabledTools={disabledTools}
              onChange={toggle}
              hint={readonlyMode ? '唯讀模式：輸出導向暫存目錄' : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
