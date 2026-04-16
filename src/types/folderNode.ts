export interface FolderNode {
  folderHash: string | null;  // 使用 String 替代 u128 传给前端，避免 JS 精度丢失
  path: string;               // 完整路径，如 "/a/b/c"
  name: string;               // 文件夹名，如 "c" (用于 UI 显示)
  imageCount: number;         // 当前文件夹下的图片数
  totalImageCount: number;    // 包含所有子文件夹的图片总数 (UI很需要)
  children: FolderNode[];     // 子节点数组
}

/** 构建文件夹树参数 */
export interface BuildFolderTreeOptions {
  /** 排序方式: 'name' | 'count' | 'date' */
  sortBy?: 'name' | 'count' | 'date';
  /** 是否降序 */
  descending?: boolean;
  /** 是否包含空文件夹 */
  includeEmpty?: boolean;
}