// theme.ts 主题偏好的读取、解析与落地。
//
// 主题是纯前端偏好：只存 localStorage，不写服务端配置，因此服务端只读模式下同样可用。
// index.html 的 <head> 里有一份等价的内联脚本，在首帧之前跑完同一套判定；两处的键名
// 与判定顺序必须保持一致，改动时同步修改。

export type Theme = 'dark' | 'light'

/** 存储键。改这里必须同时改 index.html 的内联脚本。 */
export const THEME_KEY = 'wbgui-theme'

/** 读取用户的显式选择；没有或不可读时返回 null（隐私模式下 localStorage 会抛错）。 */
export function readStoredTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return raw === 'light' || raw === 'dark' ? raw : null
  } catch {
    return null
  }
}

/** 系统偏好。matchMedia 缺失时按深色处理，与既有默认一致。 */
export function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** 生效主题：显式选择优先于系统偏好。 */
export function resolveTheme(): Theme {
  return readStoredTheme() ?? systemTheme()
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // 存不进去只影响下次开局，不影响本次切换。
  }
}

/** 系统主题变化监听；未显式选择时才跟随，返回取消订阅。 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  let mq: MediaQueryList
  try {
    mq = window.matchMedia('(prefers-color-scheme: light)')
  } catch {
    return () => undefined
  }
  const handler = (e: MediaQueryListEvent) => onChange(e.matches ? 'light' : 'dark')
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
