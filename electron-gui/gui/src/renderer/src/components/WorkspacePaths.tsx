interface Props {
  paths: string[]
  onChange: (paths: string[]) => void
}

export function WorkspacePaths({ paths, onChange }: Props) {
  const add = async () => {
    const folder = await window.electronAPI.browseFolder()
    if (folder && !paths.includes(folder)) {
      onChange([...paths, folder])
    }
  }

  const remove = (idx: number) => {
    onChange(paths.filter((_, i) => i !== idx))
  }

  const reselect = async (idx: number) => {
    const folder = await window.electronAPI.browseFolder()
    if (!folder) return
    if (paths.includes(folder) && folder !== paths[idx]) return
    onChange(paths.map((p, i) => (i === idx ? folder : p)))
  }

  return (
    <div className="space-y-2">
      {paths.map((p, i) => (
        <div key={i} className="flex items-center gap-2 group">
          <button
            onClick={() => reselect(i)}
            title="點擊重新選擇資料夾"
            className="flex-1 rounded-lg px-3 py-1.5 text-sm font-mono truncate text-left transition-colors"
            style={{ background: '#fff', border: '1px solid #ddd', color: '#333' }}
          >
            {p}
          </button>
          <button
            onClick={() => remove(i)}
            className="hover:bg-red-50 hover:text-red-600 transition-colors flex-shrink-0 font-bold text-base rounded-md w-7 h-7 flex items-center justify-center"
            style={{ color: '#444' }}
            title="移除"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="w-full rounded-lg px-3 py-2 text-sm font-semibold transition-colors text-left hover:bg-white"
        style={{ border: '1.5px dashed #999', color: '#333' }}
      >
        + 瀏覽新增資料夾...
      </button>
    </div>
  )
}
