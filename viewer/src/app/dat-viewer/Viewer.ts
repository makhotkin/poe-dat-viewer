import { DatFile, readDatFile, readColumn } from 'pathofexile-dat'
import type { ColumnStats } from 'pathofexile-dat/dat-analysis'
import { validateHeader } from 'pathofexile-dat/dat-analysis/validation'
import { getHeaderLength } from 'pathofexile-dat/dat/header'
import { Header, createHeaderFromSelected, byteView, fromSerializedHeaders } from './headers'
import * as db from './db'
import { clearColumnSelection, selectColsByHeader } from './selection'
import { shallowRef, Ref, triggerRef, shallowReactive, ComputedRef, computed } from 'vue'
import { analyzeDatFile } from '../worker/interface'
import { loadFileContent } from '../patchcdn/index-store'
import { findByName } from './db'

type ReferencedTable = null | { headers: Header[], datFile: DatFile }

export interface Viewer {
  readonly path: string
  readonly name: string
  readonly datFile: DatFile
  headers: Ref<Header[]>
  columnStats: Ref<ColumnStats[]>
  columnSelection: Ref<boolean[]>
  editHeader: Ref<Header | null>
  selectedRow: Ref<number | null>
  rowSorting: Ref<number[] | null>
  scrollPos: { x: number, y: number }
  referencedTables: ComputedRef<Map<string, Ref<ReferencedTable>>>
}

export const TABLES_WEAK_CACHE = new Map<string, WeakRef<Ref<ReferencedTable>>>()

function getTableFromCache (path: string): Ref<ReferencedTable> {
  const found = TABLES_WEAK_CACHE.get(path)?.deref()
  if (found) return found

  const out = shallowRef<ReferencedTable>(null)
  loadFromFile(path)
    .then(result => {
      if (result) {
        out.value = result
      }
    })
    .catch(() => {})

  TABLES_WEAK_CACHE.set(path, new WeakRef(out))
  return out
}

async function loadFromFile (path: string) {
  const fileContent = await loadFileContent(path)
  const datFile = readDatFile(path, fileContent)
  const columnStats = await analyzeDatFile(datFile)
  const serialized = await findByName(getNamePart(path))
  const headers = fromSerializedHeaders(serialized, columnStats, datFile)
  if (headers) {
    return {
      headers: headers.headers,
      datFile: datFile
    }
  }
}

export function createViewer (path: string, fileContent: Uint8Array): Viewer {
  const parsed = readDatFile(path, fileContent)

  const viewer: Viewer = {
    headers: shallowRef(
      parsed.rowLength
        ? [{
            name: null,
            offset: 0,
            length: parsed.rowLength,
            type: byteView()
          }]
        : []
    ),
    datFile: parsed,
    name: getNamePart(path),
    path: path,
    columnStats: shallowRef([]),
    columnSelection: shallowRef(new Array(parsed.rowLength).fill(false)),
    editHeader: shallowRef(null),
    selectedRow: shallowRef(null),
    rowSorting: shallowRef(null),
    scrollPos: shallowReactive({ x: 0, y: 0 }),
    referencedTables: computed(() => {
      const out = new Map<string, Ref<ReferencedTable>>()
      out.set(viewer.name, shallowRef({ headers: viewer.headers.value, datFile: viewer.datFile }))
      for (const header of viewer.headers.value) {
        if (!header.type.key?.table ||
            out.has(header.type.key.table)) continue

        const path = viewer.path.replace(`/${viewer.name}.`, `/${header.type.key.table}.`)
        out.set(header.type.key.table, getTableFromCache(path))
      }
      return out
    })
  }

  void analyzeDatFile(viewer.datFile)
    .then(async (stats) => {
      viewer.columnStats.value = stats
      await importHeaders(viewer)
    })

  return viewer
}

export async function importHeaders (viewer: Viewer) {
  viewer.editHeader.value = null

  viewer.headers.value = viewer.datFile.rowLength
    ? [{
        name: null,
        offset: 0,
        length: viewer.datFile.rowLength,
        type: byteView()
      }]
    : []

  const headers = await db.findByName(viewer.name)
  try {
    tryImportHeaders(headers, viewer)
  } catch (e) {
    window.alert(`WARN: ${(e as Error).message}`)
  } finally {
    triggerRef(viewer.headers)
  }
}

function tryImportHeaders (serialized: db.ViewerSerializedHeader[], viewer: Viewer): void {
  let offset = 0
  for (const hdrSerialized of serialized) {
    const headerLength = hdrSerialized.length || getHeaderLength(hdrSerialized, viewer.datFile)
    if (hdrSerialized.name == null) {
      offset += headerLength
      continue
    }

    const header: Header = {
      ...hdrSerialized,
      length: headerLength,
      offset: offset
    }

    const isValid = (hdrSerialized.length)
      ? (viewer.datFile.rowLength - header.offset) >= header.length
      : validateHeader(header, viewer.columnStats.value)
    if (!isValid) {
      throw new Error('The schema is invalid.')
    }

    selectColsByHeader(header, viewer.columnSelection.value)
    const headerCreated = createHeaderFromSelected(viewer.columnSelection.value, viewer.headers.value)
    Object.assign(headerCreated, header)
    clearColumnSelection(viewer.columnSelection.value)

    offset += headerLength
  }
}

export function exportAllRows (headers: Header[], datFile: DatFile) {
  const columns = headers
    .filter(({ type }) => type.boolean || type.decimal || type.integer || type.key || type.string)
    .map((header, idx) => ({
      name: header.name || `Unknown${idx + 1}`,
      data: readColumn(header, datFile)
    }))

  columns.unshift({
    name: '_rid',
    data: Array(datFile.rowCount).fill(undefined)
      .map((_, idx) => idx)
  })

  return Array(datFile.rowCount).fill(undefined)
    .map((_, idx) => Object.fromEntries(
      columns.map(col => [col.name, col.data[idx]])
    ))
}

function getNamePart (path: string) {
  return path.match(/[^/]+(?=\..+$)/)![0]
}

export async function saveHeaders (viewer: Viewer) {
  await db.saveHeaders(viewer.name, viewer.headers.value)
}

export async function removeHeaders (viewer: Viewer) {
  await db.removeHeaders(viewer.name)
}
