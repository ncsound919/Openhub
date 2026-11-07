/**
 * Path rules for every Team Skill write.
 *
 * A Team Skill is a folder the user can import from anywhere — a ZIP they were
 * sent, a directory they exported from another tool — so the paths inside it
 * are untrusted. One module owns the whole judgement: what a legal relative
 * path looks like, how far a path may escape the asset root, and which bytes
 * count as text. Callers never re-implement it, because a second copy is how a
 * traversal check drifts from the write it was supposed to guard.
 * @module dsh-agent-team-presets/team-skills/paths
 */
/** Most files one Team Skill folder may hold. */
export declare const MAX_SKILL_FILES = 2000;
/** Most bytes one file may hold. */
export declare const MAX_SKILL_FILE_BYTES: number;
/** Most bytes one Team Skill folder may hold. */
export declare const MAX_SKILL_BYTES: number;
/** Longest relative path accepted, so a deep tree cannot exhaust path limits. */
export declare const MAX_SKILL_PATH_LENGTH = 512;
/** Why one path or folder was refused. */
export type SkillPathFailure = 'absolute-path' | 'parent-traversal' | 'empty-path' | 'too-long' | 'nul-byte' | 'backslash' | 'drive-letter' | 'symlink-escape' | 'too-many-files' | 'file-too-large' | 'folder-too-large' | 'duplicate-path' | 'empty-folder';
/** A refusal carrying the path that produced it. */
export declare class SkillPathError extends Error {
    readonly reason: SkillPathFailure;
    readonly path: string;
    /**
     * @param reason - which rule the path broke.
     * @param path - the offending path, for the dialog.
     */
    constructor(reason: SkillPathFailure, path: string);
}
/**
 * Normalize one archive entry name into a POSIX-relative path.
 *
 * Every segment is checked, not just the whole string: `a/../b` is rejected
 * rather than collapsed, because collapsing is exactly how an importer talks
 * itself into accepting a traversal.
 * @param raw - the path as the archive or the browser reported it.
 * @returns the normalized relative path.
 * @throws {SkillPathError} when the path is absolute, escapes, or is malformed.
 */
export declare function normalizeSkillPath(raw: string): string;
/**
 * Resolve one relative path under an asset root, proving it stays inside.
 *
 * The resolved absolute path is compared with the resolved root prefix rather
 * than with string concatenation, so neither `..` nor a platform separator can
 * produce a path that merely looks contained.
 * @param root - absolute asset root.
 * @param relative - a path already accepted by {@link normalizeSkillPath}.
 * @returns the absolute path inside the root.
 * @throws {SkillPathError} when the result would leave the root.
 */
export declare function resolveInside(root: string, relative: string): string;
/**
 * Check one incoming file against the per-file limits.
 * @param path - normalized relative path.
 * @param bytes - decoded byte length.
 * @throws {SkillPathError} when the file is too large.
 */
export declare function checkFileSize(path: string, bytes: number): void;
/**
 * Check a whole folder against the count, total-size, and duplicate rules.
 * @param files - every file of the folder, already decoded.
 * @returns the total byte length.
 * @throws {SkillPathError} when a limit is exceeded or a path repeats.
 */
export declare function checkFolder(files: readonly {
    readonly path: string;
    readonly bytes: number;
}[]): number;
/**
 * Whether one byte buffer is UTF-8 text this UI may edit.
 *
 * The decision is deliberately conservative: only a buffer with no NUL byte and
 * no invalid UTF-8 sequence is treated as editable text, so a binary asset is
 * previewed and replaced rather than silently corrupted by a text editor.
 * @param bytes - file content.
 * @returns whether the bytes are editable text.
 */
export declare function isTextBytes(bytes: Uint8Array): boolean;
/**
 * Render one skill id as a safe asset directory name.
 *
 * `skillId` is validated kebab-case by the importer, so this only has to refuse
 * the two names a filesystem cannot carry; it is still a real check rather than
 * a comment, because the store is also called with ids read back from disk.
 * @param skillId - kebab-case skill name.
 * @returns the directory name.
 * @throws {SkillPathError} when the id is not a safe directory name.
 */
export declare function assetDirectoryName(skillId: string): string;
/**
 * Reject a symbolic link anywhere in one imported tree.
 *
 * A link is refused even when it points inside the folder: the link target is
 * resolved by the filesystem later, so accepting one would mean trusting a path
 * that can change after the check.
 * @param stats - the entry's `lstat` result.
 * @param path - its relative path.
 * @throws {SkillPathError} when the entry is a symbolic link.
 */
export declare function checkNotSymlink(stats: {
    isSymbolicLink(): boolean;
}, path: string): void;
/**
 * Pin the existing ancestors of a caller-selected root to their physical path.
 * A relocated home/package may have a symlink or junction in those ancestors.
 * The final root itself is deliberately not resolved: assertNoSymlinks still
 * rejects a link at that boundary, and at every descendant inside it.
 * Missing parent suffixes are retained for a fresh installation.
 */
export declare function canonicalRoot(path: string): string;
/** Reject actual symlinks in every existing component of an already pinned path. */
export declare function assertNoSymlinks(path: string): Promise<void>;
