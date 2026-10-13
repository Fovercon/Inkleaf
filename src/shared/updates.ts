export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error' | 'unsupported'
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  installationKind?: 'mac-app' | 'appimage' | 'deb'
  version?: string
  progress?: number
  message?: string
  releaseNotes?: string
  releaseUrl?: string
}
