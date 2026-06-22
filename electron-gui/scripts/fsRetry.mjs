// Windows 上防毒軟體可能短暫鎖住剛寫入/解壓的檔案，導致 rename/rm 出現 EBUSY/EPERM，重試可化解
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function retryFsOp(fn, attempts = 5, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      fn()
      return
    } catch (e) {
      if (i === attempts - 1) throw e
      await sleep(delayMs)
    }
  }
}
