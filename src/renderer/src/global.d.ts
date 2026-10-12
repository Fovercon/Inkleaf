import type { MdrApi } from '../../preload/index'

declare global {
  interface Window {
    mdr: MdrApi
  }
}

export {}
