export interface HistoryEntry { id: string; at: string; reason: string; bytes: number }
export interface HistoryVersion extends HistoryEntry { content: string }
export interface HistoryList { entries: HistoryEntry[]; limit: number; current: string }

export interface SearchOptions { query: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; path?: string; tag?: string; propertyKey?: string; propertyValue?: string }
export interface SearchMatch { path: string; line: number; text: string }
export interface SearchReport { matches: SearchMatch[]; total: number; files: number; truncated: boolean }
export interface BatchFile { path: string; count: number; before: string; after: string }
export interface BatchPreview { id: string; root: string; files: BatchFile[] }
export interface BatchResult { completed: string[]; failed?: { path: string; error: string }; pending: string[] }
