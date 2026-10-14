/** Electron adapter; the index itself is independently testable filesystem code. */
import path from 'node:path'
import { app } from 'electron'
import { DocumentIndex } from './document-index'
export type { IndexLink, DocIndexEntry, TagCount, Backlink } from './document-index'

let index: DocumentIndex | null = null
const service = () => index ??= new DocumentIndex(path.join(app.getPath('userData'), 'index.json'))
export const buildIndex = (root: string, files: string[]) => service().build(root, files)
export const clearIndex = () => service().clear()
export const indexFile = (p: string) => service().update(p)
export const unindexPath = (p: string) => service().remove(p)
export const resolveName = (name: string) => service().resolve(name)
export const queryTags = () => service().tags()
export const queryBacklinks = (name: string) => service().backlinks(name)
export const loadPersistedIndex = (root: string, files: string[]) => service().load(root, files)
export const listNames = () => service().names()
export const queryFilesByTag = (tag: string) => service().filesByTag(tag)
export const peekDoc = (p: string, maxChars = 240) => service().peek(p, maxChars)
