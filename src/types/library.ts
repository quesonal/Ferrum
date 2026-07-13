// ============================================================================
// Library-related UI types. Re-exports the existing `folderNode.ts` and adds
// view-state types (currently declared inside `libraryStore.ts`).
//
// No snake→camel conversion in this PR — that happens in Phase 4d.
// ============================================================================

export {
  type FolderNode,
  type BuildFolderTreeOptions,
} from './folderNode';

/** Grouped folder block as rendered by `FlatImageGrid.vue`. Computed locally
 *  from `flatImages` + `folderTree`; never crosses the IPC boundary. */
export interface GroupedFolder {
  hash: string;
  name: string;
  path: string;
  images: import('./ipc').FlatImageEntryDto[];
}

/** One rendered row in the folder tree, pre-computed with depth + expansion
 *  state for the virtual list. */
export interface FlatTreeNode {
  node: import('./folderNode').FolderNode;
  level: number;
  isExpanded: boolean;
  hasChildren: boolean;
}
